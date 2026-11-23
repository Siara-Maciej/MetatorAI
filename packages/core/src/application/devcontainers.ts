import {
  bundleArch,
  type ContainerDetails,
  type ContainerEngineInfo,
  type ContainerProbe,
  containerError,
  DEVCONTAINER_LABEL,
  type DevContainer,
  devContainersOf,
  execEnv,
  INSTALL_SCRIPT,
  installNeeded,
  type LinuxBundle,
  launcherIn,
  MKDIR_SCRIPT,
  PROBE_SCRIPT,
  parseProbe,
  pickContainer,
  serverDir,
} from "../domain/devcontainer.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { ContainerEngine, ProcessResult } from "../ports/index.ts";

/** The engine the composition root found, or why there is none. */
export type FoundEngine =
  | { readonly info: ContainerEngineInfo; readonly cli: ContainerEngine }
  | { readonly problem: string };

export interface DevContainersDependencies {
  readonly engine: FoundEngine;
  /** The Linux CLI bundle this installation carries for an architecture; an error when it carries none. */
  readonly bundle: (arch: "x64" | "arm64") => Result<LinuxBundle, MetatorError>;
}

export interface DevContainerList {
  /** null: neither docker nor nerdctl answered (`problem` says why). */
  readonly engine: ContainerEngineInfo | null;
  readonly containers: readonly DevContainer[];
  readonly problem: string | null;
}

/** A running dev container, probed: what every command run in it needs. */
export interface ReachedContainer {
  readonly container: DevContainer;
  readonly details: ContainerDetails;
  readonly probe: ContainerProbe;
  /** The environment of the processes started there (`execEnv`). */
  readonly env: Readonly<Record<string, string>>;
  readonly engine: ContainerEngine;
}

/** The CLI in a container. */
export interface InstalledCli {
  readonly version: string;
  readonly arch: "x64" | "arm64";
  /** The launcher, absolute in the container. */
  readonly path: string;
  /** It was copied in now (false: that version was there already). */
  readonly copied: boolean;
}

/** What a program the app runs in a container may add. */
export interface RunOptions {
  /** Its folder there; default: the workspace folder, else the home folder. */
  readonly cwd?: string;
  /** More variables (over the container's environment). */
  readonly env?: Readonly<Record<string, string>>;
  readonly stderr?: "capture" | "inherit";
}

/**
 * The person's dev containers (ADR-0106): list them, start one, copy the Linux CLI into one (once per
 * version, per user), and run programs there as its remote user with the environment a terminal of
 * the container has. Nothing here runs on the host but the engine's CLI.
 */
export class DevContainers {
  constructor(private readonly d: DevContainersDependencies) {}

  private cli(): Result<{ readonly info: ContainerEngineInfo; readonly cli: ContainerEngine }, MetatorError> {
    const e = this.d.engine;
    if ("problem" in e)
      return err(
        containerError("no-engine", e.problem, "Start Docker Desktop or Rancher Desktop, then try again."),
      );
    return ok(e);
  }

  async list(): Promise<Result<DevContainerList, MetatorError>> {
    const e = this.d.engine;
    if ("problem" in e) return ok({ engine: null, containers: [], problem: e.problem });
    const found = await this.all(e.cli);
    return found.map(({ containers }) => ({ engine: e.info, containers, problem: null }));
  }

  private async all(
    cli: ContainerEngine,
  ): Promise<Result<{ containers: DevContainer[]; details: readonly ContainerDetails[] }, MetatorError>> {
    const ids = await cli.list(DEVCONTAINER_LABEL.localFolder);
    if (ids.isErr()) return err(ids.error);
    if (ids.value.length === 0) return ok({ containers: [], details: [] });
    const details = await cli.inspect(ids.value);
    if (details.isErr()) return err(details.error);
    return ok({ containers: devContainersOf(details.value), details: details.value });
  }

  /** The container of a local folder (a running one first), with what the engine says of it. */
  async find(localFolder: string): Promise<
    Result<
      {
        readonly container: DevContainer;
        readonly details: ContainerDetails;
        readonly engine: ContainerEngine;
      },
      MetatorError
    >
  > {
    const engine = this.cli();
    if (engine.isErr()) return err(engine.error);
    const found = await this.all(engine.value.cli);
    if (found.isErr()) return err(found.error);
    const picked = pickContainer(found.value.containers, localFolder);
    if (picked.isErr()) return err(picked.error);
    const details = found.value.details.find((x) => x.id === picked.value.id) as ContainerDetails;
    return ok({ container: picked.value, details, engine: engine.value.cli });
  }

  /** Starts the container of a local folder when it is stopped; answers it as it is then. */
  async start(localFolder: string): Promise<Result<DevContainer, MetatorError>> {
    const found = await this.find(localFolder);
    if (found.isErr()) return err(found.error);
    if (found.value.container.state === "running") return ok(found.value.container);
    const started = await found.value.engine.start(found.value.container.id);
    if (started.isErr()) return err(started.error);
    const again = await this.find(localFolder);
    return again.map((f) => f.container);
  }

  /** The running container of a local folder, probed; `container-stopped` when it is not running. */
  async reach(localFolder: string): Promise<Result<ReachedContainer, MetatorError>> {
    const found = await this.find(localFolder);
    if (found.isErr()) return err(found.error);
    const { container, details, engine } = found.value;
    if (container.state !== "running")
      return err(
        containerError(
          "container-stopped",
          `the dev container of ${localFolder} is stopped`,
          "Start it (the app's Start, or `metator devcontainer start`), then try again.",
        ),
      );
    const ran = await engine.exec(container.id, {
      user: container.remoteUser,
      argv: ["sh", "-c", PROBE_SCRIPT],
      timeoutMs: 30_000,
    });
    if (ran.isErr()) return err(ran.error);
    const probe = parseProbe(ran.value.stdout);
    if (probe.isErr()) return err(probe.error);
    if (probe.value.home === "")
      return err(
        new MetatorError(
          "COMMAND_FAILED",
          `the user ${container.remoteUser} has no home folder in the container`,
        ),
      );
    return ok({ container, details, engine, probe: probe.value, env: execEnv(probe.value, details) });
  }

  /**
   * The CLI in the container: the bundle of its architecture copied in and unpacked into the remote
   * user's `~/.metator/server/<version>/`, unless that version is there already (its marker holds the
   * tarball's SHA-256). Then it is run once (`version`), so a container it cannot run in says so now.
   */
  async install(
    localFolder: string,
    say: (line: string) => void = () => undefined,
  ): Promise<Result<{ readonly cli: InstalledCli; readonly at: ReachedContainer }, MetatorError>> {
    const reached = await this.reach(localFolder);
    if (reached.isErr()) return err(reached.error);
    return this.installIn(reached.value, say);
  }

  private async installIn(
    at: ReachedContainer,
    say: (line: string) => void,
  ): Promise<Result<{ readonly cli: InstalledCli; readonly at: ReachedContainer }, MetatorError>> {
    const { container, probe } = at;
    const arch = bundleArch(probe.machine);
    if (arch === undefined)
      return err(
        containerError(
          "unsupported",
          `the container's machine is ${probe.machine || "unknown"}; MetatorAI's Linux CLI is for x86_64 and aarch64`,
        ),
      );
    const bundle = this.d.bundle(arch);
    if (bundle.isErr()) return err(bundle.error);
    const needed = installNeeded(probe, bundle.value);
    if (needed.isErr()) return err(needed.error);
    const b = bundle.value;
    const path = launcherIn(probe.home, b);
    if (!needed.value) {
      say(`MetatorAI ${b.version} is in the container already.`);
      return ok({ cli: { version: b.version, arch, path, copied: false }, at });
    }
    const engine = at.engine;
    const dir = serverDir(probe.home, b.version);
    const incoming = `${dir}.incoming.tar.gz`;
    const exec = (argv: readonly string[]) =>
      engine.exec(container.id, { user: container.remoteUser, argv, env: at.env, timeoutMs: 300_000 });
    const made = await exec(["sh", "-c", MKDIR_SCRIPT, "sh", serverDir(probe.home, "").replace(/\/$/, "")]);
    if (made.isErr()) return err(made.error);
    if (made.value.exitCode !== 0)
      return err(failed("could not make the CLI's folder in the container", made.value));
    say(`Copying MetatorAI ${b.version} (Linux ${arch}) into ${container.name} as ${container.remoteUser}…`);
    const copied = await engine.copyIn(container.id, {
      from: b.tarball,
      to: incoming,
      user: container.remoteUser,
    });
    if (copied.isErr()) return err(copied.error);
    say(`Unpacking it into ${dir}…`);
    const unpacked = await exec(["sh", "-c", INSTALL_SCRIPT, "sh", dir, incoming, b.sha256]);
    if (unpacked.isErr()) return err(unpacked.error);
    if (unpacked.value.exitCode !== 0)
      return err(failed("could not unpack the CLI in the container", unpacked.value));
    say("Checking that it runs there…");
    const runs = await exec([path, "version", "--json"]);
    if (runs.isErr()) return err(runs.error);
    if (runs.value.exitCode !== 0 || !runs.value.stdout.includes(`"${b.version}"`))
      return err(failed(`MetatorAI's CLI does not run in the container (${path})`, runs.value));
    say(`MetatorAI ${b.version} is installed in the container.`);
    return ok({ cli: { version: b.version, arch, path, copied: true }, at });
  }

  /**
   * `metator <args>` in the container, as its remote user, in the workspace folder: the CLI is
   * installed first when this version is not there.
   */
  async run(
    localFolder: string,
    args: readonly string[],
    options: RunOptions = {},
    say: (line: string) => void = () => undefined,
  ): Promise<
    Result<
      { readonly result: ProcessResult; readonly cli: InstalledCli; readonly at: ReachedContainer },
      MetatorError
    >
  > {
    const installed = await this.install(localFolder, say);
    if (installed.isErr()) return err(installed.error);
    const { cli, at } = installed.value;
    const ran = await this.execIn(at, [cli.path, ...args], options);
    return ran.map((result) => ({ result, cli, at }));
  }

  /** Any program in the running container, as its remote user, with its environment. */
  async exec(
    localFolder: string,
    argv: readonly string[],
    options: RunOptions = {},
  ): Promise<Result<ProcessResult, MetatorError>> {
    if (argv.length === 0) return err(MetatorError.usage("no program to run in the container"));
    const reached = await this.reach(localFolder);
    if (reached.isErr()) return err(reached.error);
    return this.execIn(reached.value, argv, options);
  }

  private execIn(at: ReachedContainer, argv: readonly string[], options: RunOptions) {
    return at.engine.exec(at.container.id, {
      user: at.container.remoteUser,
      argv,
      cwd: options.cwd ?? at.container.workspaceFolder ?? at.probe.home,
      env: { ...at.env, ...options.env },
      ...(options.stderr ? { stderr: options.stderr } : {}),
    });
  }

  /** The engine's program and what the tunnel needs of it. */
  engineInfo(): Result<ContainerEngineInfo, MetatorError> {
    return this.cli().map((e) => e.info);
  }
}

/** A step of the install that failed, with the last of what it said. */
function failed(what: string, r: ProcessResult): MetatorError {
  const said = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-5).join("\n");
  return new MetatorError("COMMAND_FAILED", `${what} (exit ${r.exitCode})${said ? `: ${said}` : ""}`);
}
