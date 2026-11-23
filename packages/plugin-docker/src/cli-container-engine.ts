import { existsSync } from "node:fs";
import {
  type ContainerCommand,
  type ContainerDetails,
  type ContainerEngine,
  type ContainerMount,
  type EngineFacts,
  err,
  MetatorError,
  ok,
  type ProcessResult,
  type Result,
} from "@metator/core";

/**
 * ContainerEngine on a container CLI the person has (ADR-0106): `docker` (Docker Desktop, Rancher
 * Desktop with moby; whatever context is current) or `nerdctl` (Rancher Desktop with containerd).
 * Both take the same words for what MetatorAI asks (`ps`, `inspect`, `start`, `exec`); their
 * `inspect` differs a little and is read for both. A file goes in through `exec -i … cat`, so it is
 * the user's own and the same for both CLIs.
 */
abstract class CliContainerEngine {
  constructor(protected readonly program: string) {}

  async list(label: string): Promise<Result<readonly string[], MetatorError>> {
    const r = await this.cli(["ps", "-a", "-q", "--no-trunc", "--filter", `label=${label}`]);
    return r.map((out) => [
      ...new Set(
        out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    ]);
  }

  async inspect(ids: readonly string[]): Promise<Result<readonly ContainerDetails[], MetatorError>> {
    if (ids.length === 0) return ok([]);
    const r = await this.cli(["inspect", ...ids]);
    if (r.isErr()) return err(r.error);
    let raw: unknown;
    try {
      raw = JSON.parse(r.value);
    } catch (e) {
      raw = (e as Error).message;
    }
    if (!Array.isArray(raw))
      return err(
        new MetatorError(
          "PARSE_FAILED",
          `${this.name()} inspect answered what is not a JSON list: ${String(raw).slice(0, 200)}`,
        ),
      );
    return ok(raw.map(readDetails));
  }

  async start(id: string): Promise<Result<void, MetatorError>> {
    return (await this.cli(["start", id])).map(() => undefined);
  }

  async exec(id: string, c: ContainerCommand): Promise<Result<ProcessResult, MetatorError>> {
    const argv = [this.program, "exec", ...execOptions(c), id, ...c.argv];
    return this.spawn(argv, {
      stderr: c.stderr ?? "capture",
      ...(c.timeoutMs === undefined ? {} : { timeoutMs: c.timeoutMs }),
    });
  }

  async copyIn(
    id: string,
    f: { readonly from: string; readonly to: string; readonly user: string },
  ): Promise<Result<void, MetatorError>> {
    if (!existsSync(f.from)) return err(MetatorError.notFound(`the file ${f.from}`));
    const r = await this.spawn(
      [this.program, "exec", "-i", "-u", f.user, id, "sh", "-c", 'cat > "$1"', "sh", f.to],
      { stdin: f.from, stderr: "capture" },
    );
    if (r.isErr()) return err(r.error);
    if (r.value.exitCode !== 0)
      return err(
        new MetatorError(
          "COMMAND_FAILED",
          `could not write ${f.to} in the container (exit ${r.value.exitCode}): ${r.value.stderr.trim()}`,
        ),
      );
    return ok(undefined);
  }

  /** `<program> <args>`: its stdout, or an error with what it said. */
  private async cli(args: readonly string[]): Promise<Result<string, MetatorError>> {
    const r = await this.spawn([this.program, ...args], { stderr: "capture", timeoutMs: 60_000 });
    if (r.isErr()) return err(r.error);
    if (r.value.exitCode !== 0)
      return err(
        new MetatorError(
          "COMMAND_FAILED",
          `\`${[this.name(), ...args].join(" ")}\` exited ${r.value.exitCode}: ${r.value.stderr.trim().slice(-500)}`,
        ),
      );
    return ok(r.value.stdout);
  }

  private name(): string {
    return this.program.replace(/\\/g, "/").split("/").pop() ?? this.program;
  }

  private async spawn(
    argv: readonly string[],
    o: { readonly stderr: "capture" | "inherit"; readonly timeoutMs?: number; readonly stdin?: string },
  ): Promise<Result<ProcessResult, MetatorError>> {
    const started = performance.now();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([...argv], {
        stdin: o.stdin === undefined ? "ignore" : Bun.file(o.stdin),
        stdout: "pipe",
        stderr: o.stderr === "inherit" ? "inherit" : "pipe",
      });
    } catch (e) {
      return err(
        new MetatorError("BIN_NOT_FOUND", `cannot run ${this.program}: ${(e as Error).message}`, {
          hint: "Install Docker Desktop or Rancher Desktop, or start it.",
        }),
      );
    }
    const finished = Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      o.stderr === "inherit" ? Promise.resolve("") : new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    // Killing the engine's client does not end the program in the container, which may hold its
    // output open: past the time, the answer is given without waiting for it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      if (o.timeoutMs !== undefined)
        timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve(undefined);
        }, o.timeoutMs);
    });
    const done = await Promise.race([finished, late]);
    clearTimeout(timer);
    const durationMs = performance.now() - started;
    if (done === undefined)
      return ok({ exitCode: 124, stdout: "", stderr: `timed out after ${o.timeoutMs} ms`, durationMs });
    const [stdout, stderr, exitCode] = done;
    return ok({ exitCode, stdout, stderr, durationMs });
  }
}

/** `-u`, `-w` and one `-e` per variable, in a stable order. */
function execOptions(c: ContainerCommand): string[] {
  const env = Object.entries(c.env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["-u", c.user, ...(c.cwd === undefined ? [] : ["-w", c.cwd]), ...env];
}

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** One container of `inspect`, docker's shape or nerdctl's (`--mode dockercompat`, its default). */
export function readDetails(raw: unknown): ContainerDetails {
  const c = record(raw);
  const config = record(c.Config);
  const state = record(c.State);
  const labels = Object.fromEntries(
    Object.entries(record(config.Labels ?? c.Labels)).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  const mounts: ContainerMount[] = (Array.isArray(c.Mounts) ? c.Mounts : []).map((m) => {
    const x = record(m);
    return { type: text(x.Type), source: text(x.Source), destination: text(x.Destination) };
  });
  return {
    id: text(c.Id),
    name: text(c.Name).replace(/^\//, ""),
    image: text(config.Image) || text(c.Image),
    state: text(state.Status) || (state.Running === true ? "running" : "exited"),
    user: text(config.User),
    labels,
    env: (Array.isArray(config.Env) ? config.Env : []).filter((e): e is string => typeof e === "string"),
    mounts,
    metadata: metadataOf(labels["devcontainer.metadata"]),
  };
}

/** The `devcontainer.metadata` label: a JSON list of objects (one object counts as a list of one); anything else is none. */
export function metadataOf(label: string | undefined): readonly Record<string, unknown>[] {
  if (label === undefined) return [];
  try {
    const v = JSON.parse(label) as unknown;
    const list = Array.isArray(v) ? v : [v];
    return list.filter(
      (x): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x),
    );
  } catch {
    return [];
  }
}

/** `docker`: Docker Desktop, Rancher Desktop with moby; the current docker context. */
export class DockerCliEngine extends CliContainerEngine implements ContainerEngine {
  constructor(program = "docker") {
    super(program);
  }
}

/** `nerdctl`: Rancher Desktop with containerd. */
export class NerdctlCliEngine extends CliContainerEngine implements ContainerEngine {
  constructor(program = "nerdctl") {
    super(program);
  }
}

/**
 * What one container CLI on this computer says: where it is, its engine's version when the engine
 * answers (`info`), and docker's current context. `which` finds a program on PATH.
 */
export async function engineFacts(
  program: "docker" | "nerdctl",
  which: (name: string) => string | null,
): Promise<EngineFacts> {
  const path = which(program);
  if (path === null) return { program, path: null, version: null, context: null, said: "" };
  const run = async (args: readonly string[]) => {
    try {
      const p = Bun.spawn([path, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
      const [out, said, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      clearTimeout(timer);
      return { out: out.trim(), said: said.trim(), code };
    } catch (e) {
      return { out: "", said: (e as Error).message, code: 127 };
    }
  };
  const info = await run(["info", "--format", "{{.ServerVersion}}"]);
  const version = info.code === 0 && info.out !== "" && !info.out.includes("<no value>") ? info.out : null;
  const context =
    program === "docker" && version !== null ? (await run(["context", "show"])).out || null : null;
  const said = version === null ? ((info.said || info.out).split(/\r?\n/).filter(Boolean).pop() ?? "") : "";
  return { program, path, version, context, said };
}
