import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  err,
  type HostSandbox,
  MetatorError,
  ok,
  type PtyHandle,
  type PtySize,
  type Result,
  type SandboxLaunch,
  type SandboxSettings,
  type Terminal,
} from "@metator/core";

/** What a process started in the sandbox finds in its environment: it is inside one. */
export const SANDBOX_ENV = "METATOR_SANDBOX";

/** Where the sandbox runtime's command line lives (`srt`, from `@anthropic-ai/sandbox-runtime`). */
export function srtCli(): string {
  const manifest = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json");
  return join(dirname(manifest), "dist", "cli.js");
}

/**
 * HostSandbox on Anthropic's sandbox runtime (`@anthropic-ai/sandbox-runtime`, ADR-0104), the
 * one Claude Code holds its own commands in: bubblewrap on Linux, `sandbox-exec` on macOS, with
 * the network through its proxy. The session is `srt --settings <file> -- env METATOR_SANDBOX=1
 * <argv>`, run by the runtime this program runs on. The settings file is named by its content
 * and kept outside every path a session may write (`~/.cache/metator/sandbox`), and written again
 * before each start, so no session changes the next one's.
 */
export class SrtSandbox implements HostSandbox {
  constructor(
    private readonly dir: string = join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
      "metator",
      "sandbox",
    ),
    private readonly runtime: string = process.execPath,
    private readonly cli: () => string = srtCli,
  ) {}

  command(argv: readonly string[], settings: SandboxSettings): Result<string[], MetatorError> {
    if (argv.length === 0) return err(MetatorError.usage("nothing to start in the sandbox: empty argv"));
    const text = `${JSON.stringify(settings, null, 2)}\n`;
    const file = join(this.dir, `${createHash("sha256").update(text).digest("hex").slice(0, 16)}.json`);
    let cli: string;
    try {
      cli = this.cli();
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, text, { mode: 0o644 });
    } catch (e) {
      return err(
        new MetatorError("COMMAND_FAILED", `cannot prepare the sandbox: ${(e as Error).message}`, {
          hint: "The sandbox runtime comes with MetatorAI (`bun install`); `metator doctor` says what the machine lacks.",
        }),
      );
    }
    return ok([this.runtime, cli, "--settings", file, "--", "env", `${SANDBOX_ENV}=1`, ...argv]);
  }
}

/** Every process below `pid`, read from `/proc` (Linux); none where there is no `/proc`. */
export function descendants(pid: number, proc = "/proc"): number[] {
  let entries: string[];
  try {
    entries = readdirSync(proc).filter((e) => /^\d+$/.test(e));
  } catch {
    return [];
  }
  const parent = new Map<number, number>();
  for (const e of entries) {
    try {
      // The command name is in parentheses and may hold spaces: the parent pid is after the last ")".
      const stat = readFileSync(join(proc, e, "stat"), "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      parent.set(Number(e), ppid);
    } catch {
      // gone meanwhile
    }
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const at = queue.shift() as number;
    for (const [child, ppid] of parent)
      if (ppid === at && !out.includes(child)) {
        out.push(child);
        queue.push(child);
      }
  }
  return out;
}

const signal = (pids: readonly number[], name: NodeJS.Signals) => {
  for (const p of pids)
    try {
      process.kill(p, name);
    } catch {
      // gone meanwhile
    }
};

/**
 * A terminal whose sessions start through a launch (ADR-0104): in the sandbox when the repository
 * has one. Inside bubblewrap the session has a terminal of its own session, so the pseudo-terminal
 * does not tell it about a new size: each resize is passed on as SIGWINCH, and a kill as SIGHUP,
 * to every process below the sandbox's own.
 */
export class SandboxedTerminal implements Terminal {
  constructor(
    private readonly inner: Terminal,
    private readonly launch: SandboxLaunch,
    private readonly below: (pid: number) => number[] = descendants,
  ) {}

  spawn(
    argv: readonly string[],
    options: {
      readonly cwd: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly size?: PtySize;
    },
  ): Result<PtyHandle, MetatorError> {
    const launched = this.launch(argv, options.cwd);
    if (launched.isErr()) return err(launched.error);
    const handle = this.inner.spawn(launched.value.argv, options);
    if (handle.isErr() || !launched.value.sandboxed) return handle;
    const h = handle.value;
    return ok({
      pid: h.pid,
      write: (data) => h.write(data),
      resize: (cols, rows) => {
        h.resize(cols, rows);
        signal(this.below(h.pid), "SIGWINCH");
      },
      onData: (listener) => h.onData(listener),
      onExit: (listener) => h.onExit(listener),
      kill: () => {
        signal(this.below(h.pid), "SIGHUP");
        h.kill();
      },
    });
  }
}
