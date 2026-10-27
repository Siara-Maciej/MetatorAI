import {
  affectedServices,
  assignPorts,
  type Environment,
  EnvironmentDocument,
  type EnvState,
  EnvStateDocument,
  healthTarget,
  lintEnvironment,
  type PortMap,
  placeData,
  postgresTarget,
  type RunningService,
  type Service,
  type Step,
  serviceEnv,
  startOrder,
} from "../domain/environment.ts";
import { type EnvironmentProposal, proposeEnvironment } from "../domain/environment-discovery.ts";
import type { Phase } from "../domain/environment-profile.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  parseJsonDocument,
  parseYamlDocument,
  renderYamlDocument,
  serializeJsonDocument,
} from "../domain/versioned.ts";
import { portVariables, type WorktreeEntry } from "../domain/worktree.ts";
import type {
  BackgroundProcess,
  Clock,
  ComposeService,
  ContainerRuntime,
  DataIsolator,
  FileSystem,
  HealthProbe,
  PackageManagerDetector,
  ProcessRunner,
  TreeCopier,
  WorkspaceReader,
} from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";
import type { WorktreeRegistry } from "./worktrees.ts";

/** The repository's `metator/environment.yml`, validated and linted. */
export class EnvironmentCatalog {
  constructor(
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async load(): Promise<Result<Environment, MetatorError>> {
    const file = this.paths.environment;
    if (!(await this.fs.exists(file))) {
      return err(
        new MetatorError("NOT_FOUND", `no ${file}`, {
          hint: "Run `metator env discover` to see a proposal, then `metator env init` to write it.",
        }),
      );
    }
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    const env = parseYamlDocument(text.value, file).andThen((raw) => EnvironmentDocument.parse(raw, file));
    if (env.isErr()) return err(env.error);
    const problems = lintEnvironment(env.value);
    if (problems.length > 0) {
      return err(
        new MetatorError("INVALID_CONFIG", `${file}: ${problems.length} problem(s)`, {
          hint: "Fix the services named in the details.",
          details: { problems },
        }),
      );
    }
    return ok(env.value);
  }
}

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const START_SCRIPTS = ["dev", "start", "serve"];

/** `env discover`: how this repository starts, from its files, with evidence; nothing is started. */
export class DiscoverEnvironment {
  constructor(
    private readonly fs: FileSystem,
    private readonly packageManager: PackageManagerDetector,
    private readonly workspace: WorkspaceReader,
  ) {}

  async execute(): Promise<Result<EnvironmentProposal, MetatorError>> {
    const compose = [];
    for (const file of COMPOSE_FILES) {
      if (!(await this.fs.exists(file))) continue;
      const text = await this.fs.read(file);
      if (text.isErr()) return err(text.error);
      const doc = parseYamlDocument(text.value, file);
      if (doc.isErr()) return err(doc.error);
      compose.push({ file, doc: doc.value });
    }
    const pm = await this.packageManager.detect();
    const runScript = `${pm.isOk() && pm.value ? pm.value.name : "npm"} run`;
    const packages = await this.workspace.packages();
    const dirs = packages.isOk()
      ? [".", ...packages.value.map((p) => p.dir).filter((d) => d !== ".")]
      : ["."];
    const scripts = [];
    for (const dir of dirs) {
      const file = dir === "." ? "package.json" : `${dir}/package.json`;
      if (!(await this.fs.exists(file))) continue;
      const text = await this.fs.read(file);
      if (text.isErr()) continue;
      const raw = parseJsonDocument(text.value, file);
      const all = raw.isOk() ? ((raw.value as { scripts?: Record<string, string> }).scripts ?? {}) : {};
      const name = START_SCRIPTS.find((s) => typeof all[s] === "string");
      // A root that only fans out to the workspaces is not a service of its own.
      if (name && !(dir === "." && dirs.length > 1))
        scripts.push({ dir, name, script: name, body: all[name] as string });
    }
    const read = async (f: string) =>
      (await this.fs.exists(f)) ? (await this.fs.read(f)).unwrapOr("") : undefined;
    const procfile = await read("Procfile");
    const makefile = await read("Makefile");
    return ok(
      proposeEnvironment({
        compose,
        scripts,
        runScript,
        ...(procfile !== undefined ? { procfile } : {}),
        ...(makefile !== undefined ? { makefile } : {}),
      }),
    );
  }
}

/** `env init`: writes the proposal as `metator/environment.yml`; never overwrites. */
export class InitEnvironment {
  constructor(
    private readonly discover: Pick<DiscoverEnvironment, "execute">,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async execute(input: {
    readonly dryRun: boolean;
  }): Promise<
    Result<EnvironmentProposal & { readonly written: string | null; readonly text: string }, MetatorError>
  > {
    const file = this.paths.environment;
    if (!input.dryRun && (await this.fs.exists(file))) {
      return err(MetatorError.usage(`${file} already exists`, "Edit it; `env init` never overwrites."));
    }
    const proposal = await this.discover.execute();
    if (proposal.isErr()) return err(proposal.error);
    if (!proposal.value.environment) {
      return err(
        MetatorError.usage(
          "nothing to start was found",
          `Write ${file} by hand: one service per process or container (\`metator env schema\`).`,
        ),
      );
    }
    const text = renderYamlDocument(
      { ...EnvironmentDocument.stamp(proposal.value.environment) },
      "Proposed by `metator env init`; check scopes, ports and health checks.",
    );
    if (!input.dryRun) {
      const saved = await this.fs.write(file, text);
      if (saved.isErr()) return err(saved.error);
    }
    return ok({ ...proposal.value, written: input.dryRun ? null : file, text });
  }
}

export interface ServiceReport {
  readonly service: string;
  readonly scope: string;
  readonly place: string;
  readonly status: "started" | "running" | "stopped" | "not running";
  readonly ports: Readonly<Record<string, number>>;
  readonly pid?: number;
  readonly ms?: number;
  /** What the start took, phase by phase: isolate, reuse, prepare steps, start, template, init steps. */
  readonly phases?: readonly Phase[];
}

export interface EnvTarget {
  /** The worktree to run in; the repository's own checkout when omitted. */
  readonly worktree?: string;
}

/** The adapters that start services and get them ready (F8.5, F8.7). */
export interface StartTools {
  readonly processes: BackgroundProcess;
  readonly containers: ContainerRuntime;
  readonly health: HealthProbe;
  /** Runs `prepare` and `init` steps. */
  readonly steps: ProcessRunner;
  readonly isolator: DataIsolator;
  readonly copier: TreeCopier;
}

const STEP_TIMEOUT_MS = 30 * 60_000;
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];

/** `env up|down|status|logs`: start, stop and inspect the services of a place. */
export class EnvironmentServices {
  constructor(
    private readonly catalog: EnvironmentCatalog,
    private readonly registry: WorktreeRegistry,
    private readonly tools: StartTools,
    private readonly fs: FileSystem,
    private readonly clock: Clock,
    private readonly paths: MetatorPaths,
    /** Absolute repository root and a directory for process logs (outside the repository). */
    private readonly where: { readonly root: string; readonly logDir: string },
  ) {}

  async up(
    input: EnvTarget & {
      readonly services?: readonly string[];
      readonly profile?: string;
      /** Changed files: start only the services they touch (`env up --affected`) and what those need. */
      readonly affected?: readonly string[];
    },
  ): Promise<Result<readonly ServiceReport[], MetatorError>> {
    const ctx = await this.context(input.worktree);
    if (ctx.isErr()) return err(ctx.error);
    const { env, wt, ports } = ctx.value;
    let wanted = input.services && input.services.length > 0 ? input.services : undefined;
    if (input.profile) {
      const profile = env.profiles[input.profile];
      if (!profile)
        return err(
          MetatorError.usage(
            `no profile ${input.profile}`,
            `Profiles: ${Object.keys(env.profiles).join(", ") || "none"}.`,
          ),
        );
      wanted = profile;
    }
    if (input.affected) wanted = affectedServices(env, input.affected);
    const unknown = (wanted ?? []).filter((s) => !env.services[s]);
    if (unknown.length > 0) return err(MetatorError.usage(`unknown service(s): ${unknown.join(", ")}`));

    const reports: ServiceReport[] = [];
    const order = wanted && wanted.length === 0 ? [] : startOrder(env, wanted);
    for (const id of order) {
      const s = env.services[id];
      if (!s) continue;
      const place = s.scope === "shared" ? "shared" : (wt?.id ?? "main");
      const state = await this.state(place);
      if (state.isErr()) return err(state.error);
      const running = state.value.services[id];
      if (running && this.alive(running)) {
        reports.push({
          service: id,
          scope: s.scope,
          place,
          status: "running",
          ports: running.ports,
          ...(running.pid ? { pid: running.pid } : {}),
        });
        continue;
      }
      const started = this.clock.now().getTime();
      const phases: Phase[] = [];
      const timed = async <T>(name: string, run: () => Promise<Result<T, MetatorError>>) => {
        const t = this.clock.now().getTime();
        const r = await run();
        phases.push({ name, ms: this.clock.now().getTime() - t });
        return r;
      };
      const cwd = s.scope === "shared" || !wt ? this.where.root : `${this.where.root}/${wt.path}`;
      const dir = "script" in s.source && s.source.cwd ? `${cwd}/${s.source.cwd}` : cwd;
      const userPlace = wt?.id ?? "main";
      const vars = { ...serviceEnv(env, ports, id, userPlace), ...(wt ? portVariables(wt) : {}) };
      const fail = (e: MetatorError) => err(withStarted(e, reports));

      if (s.scope !== "shared") {
        const isolated = await timed("isolate", () => this.isolate(env, ports, s.needs, userPlace));
        if (isolated.isErr()) return fail(isolated.error);
        if (isolated.value === 0) phases.pop();
      }
      if (s.warm && wt) {
        const reused = await timed("reuse", () => this.reuse(s.warm as NonNullable<Service["warm"]>, cwd));
        if (reused.isErr()) return fail(reused.error);
      }
      for (const step of s.prepare) {
        const r = await timed(step.name, () => this.step(id, step, dir, vars));
        if (r.isErr()) return fail(r.error);
      }

      const t0 = this.clock.now().getTime();
      let entry: RunningService;
      if ("compose" in s.source) {
        const svc = this.compose(id, env, place, cwd, vars);
        const up = await this.tools.containers.up(svc);
        if (up.isErr()) return fail(up.error);
        entry = {
          kind: "compose",
          project: svc.project,
          ports: ports[id] ?? {},
          startedAt: this.clock.now().toISOString(),
        };
      } else {
        const log = `${this.where.logDir}/metator-env-${place}-${id}.log`;
        const pid = await this.tools.processes.start(["sh", "-c", s.source.script], dir, log, vars);
        if (pid.isErr()) return fail(pid.error);
        entry = {
          kind: "process",
          pid: pid.value,
          ports: ports[id] ?? {},
          log,
          startedAt: this.clock.now().toISOString(),
        };
      }
      const saved = await this.save(place, { services: { ...state.value.services, [id]: entry } });
      if (saved.isErr()) return err(saved.error);
      const target = healthTarget(env, ports, id);
      if (target) {
        const ready = await this.tools.health.waitFor(target, s.readyTimeoutMs);
        if (ready.isErr()) {
          const tail = entry.log ? await this.tools.processes.readLog(entry.log, 20) : "";
          return err(
            new MetatorError("COMMAND_FAILED", `${id} did not become ready within ${s.readyTimeoutMs} ms`, {
              hint: `See \`metator env logs ${id}${wt ? ` --worktree ${wt.id}` : ""}\`; it keeps running for that.`,
              details: { started: reports, health: target, log: tail },
            }),
          );
        }
      }
      phases.push({ name: "start", ms: this.clock.now().getTime() - t0 });

      let initVars = vars;
      const pg = postgresTarget(env, ports, id);
      if (pg && s.isolate && "postgres" in s.isolate) {
        // The template is what init fills; every place is cloned from it later.
        const template = s.isolate.postgres.template;
        const created = await timed("template", () => this.tools.isolator.createDatabase(pg, template));
        if (created.isErr()) return fail(created.error);
        initVars = { ...vars, METATOR_DATABASE: template };
      }
      for (const step of s.init) {
        const r = await timed(step.name, () => this.step(id, step, dir, initVars));
        if (r.isErr()) return fail(r.error);
      }
      reports.push({
        service: id,
        scope: s.scope,
        place,
        status: "started",
        ports: entry.ports,
        ...(entry.pid ? { pid: entry.pid } : {}),
        ms: this.clock.now().getTime() - started,
        phases,
      });
    }
    return ok(reports);
  }

  /**
   * Drops the isolated databases of a worktree (after `worktree rm`, which already forgot it: shared
   * services keep their ports in every place); the names it dropped.
   */
  async dropData(input: Required<EnvTarget>): Promise<Result<readonly string[], MetatorError>> {
    const ctx = await this.context(undefined);
    if (ctx.isErr()) return err(ctx.error);
    const { env, ports } = ctx.value;
    const dropped: string[] = [];
    const shared = await this.state("shared");
    if (shared.isErr()) return err(shared.error);
    for (const [id, s] of Object.entries(env.services)) {
      const pg = postgresTarget(env, ports, id);
      const running = shared.value.services[id];
      const name = placeData(s, input.worktree).database;
      if (!pg || !name || !running || !this.alive(running)) continue;
      const r = await this.tools.isolator.dropDatabase(pg, name);
      if (r.isErr()) return err(r.error);
      if (r.value) dropped.push(name);
    }
    return ok(dropped);
  }

  /** Creates the place's databases on the isolated shared services it needs; how many it created. */
  private async isolate(
    env: Environment,
    ports: PortMap,
    needs: readonly string[],
    place: string,
  ): Promise<Result<number, MetatorError>> {
    let created = 0;
    for (const n of needs) {
      const s = env.services[n];
      const pg = postgresTarget(env, ports, n);
      if (!s?.isolate || !("postgres" in s.isolate) || !pg) continue;
      const name = placeData(s, place).database as string;
      const r = await this.tools.isolator.createDatabase(pg, name, s.isolate.postgres.template);
      if (r.isErr()) return err(r.error);
      if (r.value) created++;
    }
    return ok(created);
  }

  /** Copies build output from the main checkout when the key files are equal in both. */
  private async reuse(
    warm: NonNullable<Service["warm"]>,
    cwd: string,
  ): Promise<Result<readonly string[], MetatorError>> {
    const rel = cwd.slice(this.where.root.length + 1);
    const keys = warm.key ?? LOCKFILES;
    for (const k of keys) {
      const [main, here] = await Promise.all([this.readOr(k), this.readOr(`${rel}/${k}`)]);
      if (main !== here) return ok([]);
    }
    const copied: string[] = [];
    for (const path of warm.reuse) {
      const r = await this.tools.copier.copy(`${this.where.root}/${path}`, `${cwd}/${path}`);
      if (r.isErr()) return err(r.error);
      if (r.value) copied.push(path);
    }
    return ok(copied);
  }

  private async readOr(path: string): Promise<string | undefined> {
    if (!(await this.fs.exists(path))) return undefined;
    return (await this.fs.read(path)).unwrapOr(undefined);
  }

  private async step(
    id: string,
    step: Step,
    dir: string,
    vars: Readonly<Record<string, string>>,
  ): Promise<Result<void, MetatorError>> {
    const r = await this.tools.steps.run(
      { argv: ["sh", "-c", step.run], cwd: step.cwd ? `${dir}/${step.cwd}` : dir, env: vars },
      { timeoutMs: STEP_TIMEOUT_MS },
    );
    if (r.exitCode === 0) return ok(undefined);
    return err(
      new MetatorError("COMMAND_FAILED", `${id}: step ${step.name} exited with ${r.exitCode}`, {
        hint: `Run it yourself: ${step.run}`,
        details: { output: `${r.stdout}${r.stderr}`.split("\n").slice(-20).join("\n") },
      }),
    );
  }

  /** Stops the place's services; shared ones only with `shared`, since other worktrees use them. */
  async down(
    input: EnvTarget & { readonly services?: readonly string[]; readonly shared?: boolean },
  ): Promise<Result<readonly string[], MetatorError>> {
    const ctx = await this.context(input.worktree);
    if (ctx.isErr()) return err(ctx.error);
    const { env, wt } = ctx.value;
    const stopped: string[] = [];
    for (const place of [wt?.id ?? "main", ...(input.shared ? ["shared"] : [])]) {
      const state = await this.state(place);
      if (state.isErr()) return err(state.error);
      const left: Record<string, RunningService> = {};
      // Dependents first: the reverse of the start order.
      const order = startOrder(env, Object.keys(env.services)).reverse();
      const names = [...order, ...Object.keys(state.value.services).filter((n) => !order.includes(n))];
      for (const id of names) {
        const running = state.value.services[id];
        if (!running) continue;
        if (input.services && input.services.length > 0 && !input.services.includes(id)) {
          left[id] = running;
          continue;
        }
        if (running.kind === "process" && running.pid) {
          const r = await this.tools.processes.stop(running.pid);
          if (r.isErr()) return err(r.error);
        } else if (running.kind === "compose") {
          const cwd = place === "shared" || !wt ? this.where.root : `${this.where.root}/${wt.path}`;
          const r = await this.tools.containers.stop(this.compose(id, env, place, cwd, {}));
          if (r.isErr()) return err(r.error);
        }
        stopped.push(id);
      }
      const saved = await this.save(place, { services: left });
      if (saved.isErr()) return err(saved.error);
    }
    return ok(stopped);
  }

  async status(input: EnvTarget): Promise<Result<readonly ServiceReport[], MetatorError>> {
    const ctx = await this.context(input.worktree);
    if (ctx.isErr()) return err(ctx.error);
    const { env, wt, ports } = ctx.value;
    const out: ServiceReport[] = [];
    for (const [id, s] of Object.entries(env.services)) {
      const place = s.scope === "shared" ? "shared" : (wt?.id ?? "main");
      const state = await this.state(place);
      if (state.isErr()) return err(state.error);
      const running = state.value.services[id];
      const up = running !== undefined && this.alive(running);
      out.push({
        service: id,
        scope: s.scope,
        place,
        status: up ? "running" : "not running",
        ports: running?.ports ?? ports[id] ?? {},
        ...(up && running?.pid ? { pid: running.pid } : {}),
      });
    }
    return ok(out);
  }

  async logs(
    input: EnvTarget & { readonly service: string; readonly lines: number },
  ): Promise<Result<string, MetatorError>> {
    const ctx = await this.context(input.worktree);
    if (ctx.isErr()) return err(ctx.error);
    const { env, wt } = ctx.value;
    const s = env.services[input.service];
    if (!s) return err(MetatorError.usage(`unknown service ${input.service}`));
    const place = s.scope === "shared" ? "shared" : (wt?.id ?? "main");
    const state = await this.state(place);
    if (state.isErr()) return err(state.error);
    const running = state.value.services[input.service];
    if (!running) return err(MetatorError.notFound(`a started ${input.service} in ${place}`));
    if (running.kind === "process")
      return ok(await this.tools.processes.readLog(running.log ?? "", input.lines));
    const cwd = place === "shared" || !wt ? this.where.root : `${this.where.root}/${wt.path}`;
    return this.tools.containers.logs(this.compose(input.service, env, place, cwd, {}), input.lines);
  }

  private compose(
    id: string,
    env: Environment,
    place: string,
    cwd: string,
    vars: Readonly<Record<string, string>>,
  ): ComposeService {
    const source = env.services[id]?.source as { compose: { file: string; service: string } };
    return {
      file: source.compose.file,
      service: source.compose.service,
      project: `metator-${place}`,
      cwd,
      env: vars,
    };
  }

  private alive(s: RunningService): boolean {
    return s.kind === "compose" || (s.pid !== undefined && this.tools.processes.isAlive(s.pid));
  }

  private async context(
    worktree: string | undefined,
  ): Promise<
    Result<
      { env: Environment; wt: WorktreeEntry | undefined; ports: ReturnType<typeof assignPorts> & object },
      MetatorError
    >
  > {
    const env = await this.catalog.load();
    if (env.isErr()) return err(env.error);
    let wt: WorktreeEntry | undefined;
    if (worktree) {
      const entry = await this.registry.get(worktree);
      if (entry.isErr()) return err(entry.error);
      wt = entry.value;
    }
    const ports = assignPorts(env.value, wt?.ports);
    if (!ports) {
      return err(
        MetatorError.usage(
          `worktree ${worktree}'s block of ${wt?.ports.count} ports is too small for its services`,
          "Create the worktree with more ports (`metator worktree new <id> --ports <n>`).",
        ),
      );
    }
    return ok({ env: env.value, wt, ports });
  }

  private stateFile(place: string): string {
    return `${this.paths.envState}/${place}.json`;
  }

  private async state(place: string): Promise<Result<EnvState, MetatorError>> {
    const file = this.stateFile(place);
    if (!(await this.fs.exists(file))) return ok({ services: {} });
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    return parseJsonDocument(text.value, file).andThen((raw) => EnvStateDocument.parse(raw, file));
  }

  private save(place: string, state: EnvState): Promise<Result<void, MetatorError>> {
    return this.fs.write(this.stateFile(place), serializeJsonDocument(EnvStateDocument.stamp(state)));
  }
}

/** A failed start still says what it started before, so the person knows what is running. */
function withStarted(e: MetatorError, started: readonly ServiceReport[]): MetatorError {
  return new MetatorError(e.code, e.message, {
    ...(e.hint ? { hint: e.hint } : {}),
    details: { ...(typeof e.details === "object" && e.details ? e.details : {}), started },
  });
}
