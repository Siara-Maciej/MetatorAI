import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  CONFORMANCE_WORKFLOW,
  type ConformanceLab,
  err,
  GuardAskedDocument,
  GuardConsentsDocument,
  HOST_TARGETS,
  type LabAction,
  type LabQuestion,
  type LabView,
  MetatorError,
  ok,
  parseJsonDocument,
  type Result,
} from "@metator/core";
import type { BootstrapOptions } from "@metator/runtime";

/**
 * The host conformance suite's throwaway repository (ADR-0098), as only this program can make it:
 * a fresh git repository set up for the host by `metator setup`, a daemon of its own (`metator
 * serve`) that drives the host's real CLI in its panes, and every call a person's: a thread's chat
 * opened, words typed through the pane's socket, answers given in the inbox, `metator session
 * tell|interrupt`, the daemon killed and started again. Nothing of it outlives `close`.
 */

/** The workflow of the run whose session the suite steers: one person's gate, so nothing moves it. */
const WORKFLOW = `kind: Workflow
schemaVersion: 3
id: ${CONFORMANCE_WORKFLOW}
revision: 1
description: The host conformance suite's run; a person talks to its one session, nothing moves it
stages:
  - id: talk
    description: A person talks to the session; only a person's approval would move the run
    hitl: true
`;

/** The environment of a session that ran this command, never handed to the suite's own processes. */
const NOT_PASSED = /^(CLAUDE_CODE_|CLAUDECODE$|METATOR_(PANE_|RUN$|ROLE$|DRIVEN$|NOW$|HOST$))/;

interface Daemon {
  readonly proc: Bun.Subprocess<"ignore", "ignore", "pipe">;
  readonly url: string;
}

interface LabOptions {
  /** How this program runs itself (`bun …/main.ts`). */
  readonly metator: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The repository the command runs in: `--out` is relative to it. */
  readonly root: string;
}

export class DaemonLab implements ConformanceLab {
  private dir = "";
  private repo = "";
  private out = "";
  private host = "";
  private user = "conformance";
  private daemon: Daemon | undefined;
  private env: Record<string, string> = {};
  private readonly interrupted = () => {
    void this.close(false).then(() => process.exit(130));
  };

  constructor(private readonly o: LabOptions) {}

  async open(input: {
    readonly host: string;
    readonly out: string;
  }): Promise<Result<{ readonly repo: string; readonly os: string }, MetatorError>> {
    this.host = input.host;
    this.out = isAbsolute(input.out) ? input.out : join(this.o.root, input.out);
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), `metator-conformance-${input.host}-`)));
    this.repo = join(this.dir, `conformance-${Math.random().toString(36).slice(2, 8)}`);
    process.once("SIGINT", this.interrupted);
    process.once("SIGTERM", this.interrupted);
    const bin = join(this.dir, "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(this.repo, { recursive: true });
    writeFileSync(join(bin, "metator"), `#!/bin/sh\nexec ${this.o.metator.map(quote).join(" ")} "$@"\n`);
    chmodSync(join(bin, "metator"), 0o755);
    this.user = this.o.env.METATOR_USER ?? "conformance";
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.o.env)) if (v !== undefined && !NOT_PASSED.test(k)) env[k] = v;
    this.env = {
      ...env,
      PATH: `${bin}:${this.o.env.PATH ?? ""}`,
      METATOR_STATE_DIR: join(this.dir, "state"),
      METATOR_CONFIG_DIR: join(this.dir, "config"),
      METATOR_USER: this.user,
      METATOR_HOST: input.host,
      GIT_AUTHOR_NAME: "MetatorAI conformance",
      GIT_AUTHOR_EMAIL: "conformance@metator.invalid",
      GIT_COMMITTER_NAME: "MetatorAI conformance",
      GIT_COMMITTER_EMAIL: "conformance@metator.invalid",
    };
    const steps: (readonly string[])[] = [["git", "init", "-q", "-b", "main"]];
    for (const step of steps) {
      const ran = this.run(step);
      if (ran.isErr()) return err(ran.error);
    }
    writeFileSync(
      join(this.repo, "README.md"),
      "# Conformance\n\nA throwaway repository of MetatorAI's host conformance suite.\n",
    );
    const setup = this.run([
      "metator",
      "setup",
      ...((HOST_TARGETS as readonly string[]).includes(input.host) ? ["--host", input.host] : []),
      "--yes",
    ]);
    if (setup.isErr())
      return err(new MetatorError("COMMAND_FAILED", `metator setup failed: ${setup.error.message}`));
    mkdirSync(join(this.repo, ".github/metator/workflows"), { recursive: true });
    writeFileSync(join(this.repo, `.github/metator/workflows/${CONFORMANCE_WORKFLOW}.yml`), WORKFLOW);
    for (const step of [
      ["git", "add", "-A"],
      ["git", "commit", "-q", "-m", "MetatorAI set up for the conformance suite"],
    ]) {
      const ran = this.run(step);
      if (ran.isErr()) return err(ran.error);
    }
    const started = await this.start(true);
    if (started.isErr()) return err(started.error);
    return ok({ repo: this.repo, os: `${platform()} ${arch()} ${release()}` });
  }

  async act(a: LabAction): Promise<Result<{ readonly pane?: string }, MetatorError>> {
    switch (a.kind) {
      case "session": {
        if (a.session === "chat") {
          const made = await this.call<{ pane?: { id: string } }>("POST", "/threads", {
            title: a.title ?? "Conformance",
            by: this.user,
            host: this.host,
          });
          if (made.isErr()) return err(made.error);
          return made.value.pane
            ? ok({ pane: made.value.pane.id })
            : err(MetatorError.usage("the thread opened no chat pane"));
        }
        const run = this.metator<{ runId: string }>([
          "run",
          "new",
          "--workflow",
          CONFORMANCE_WORKFLOW,
          "--task",
          "Host conformance: a person talks to this run's session",
        ]);
        if (run.isErr()) return err(run.error);
        const pane = await this.call<{ id: string }>("POST", "/panes", {
          runId: run.value.runId,
          role: "worker",
          label: "conformance",
          host: this.host,
          agent: "session",
          prompt: a.prompt ?? "",
        });
        return pane.map((p) => ({ pane: p.id }));
      }
      case "type":
        return (await this.type(a.pane, a.text, a.enter)).map(() => ({}));
      case "answer":
        return (
          await this.call("POST", `/panes/${encodeURIComponent(a.pane)}/answer`, {
            question: a.question,
            choices: [a.choice],
            by: this.user,
          })
        ).map(() => ({}));
      case "tell":
      case "interrupt":
        return this.metator(["session", a.kind, a.pane, "--text", a.text, "--by", this.user]).map(() => ({}));
      case "restart": {
        const killed = this.stop("SIGKILL");
        await Bun.sleep(500);
        if (killed.isErr()) return err(killed.error);
        return (await this.start(false)).map(() => ({}));
      }
      case "continue":
        return (
          await this.call("POST", `/panes/${encodeURIComponent(a.pane)}/continue`, { by: this.user })
        ).map(() => ({}));
      case "write": {
        const file = join(this.repo, a.path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, a.text);
        return a.stage ? this.run(["git", "add", "--", a.path]).map(() => ({})) : ok({});
      }
    }
  }

  async look(input: {
    readonly pane?: string;
    readonly files: readonly string[];
  }): Promise<Result<LabView, MetatorError>> {
    const files = Object.fromEntries(
      input.files.map((f) => {
        const at = join(this.repo, f);
        return [f, existsSync(at) ? readFileSync(at, "utf8") : undefined];
      }),
    );
    const git = {
      commits: Number(this.run(["git", "rev-list", "--count", "HEAD"]).unwrapOr("0")) || 0,
      subject: this.run(["git", "log", "-1", "--format=%s"]).unwrapOr(""),
    };
    if (!input.pane) return ok({ screen: "", questions: [], guard: [], consents: { kinds: [] }, git, files });
    const pane = input.pane;
    const layout = await this.call<{ panes: PaneSeen[] }>("GET", "/layout");
    if (layout.isErr()) return err(layout.error);
    const seen = layout.value.panes.find((p) => p.id === pane);
    const shown = await this.call<{ text?: string }>("GET", `/panes/${encodeURIComponent(pane)}?lines=2000`);
    const inbox = await this.call<{ panes?: { paneId: string; question: QuestionSeen }[] }>("GET", "/inbox");
    if (inbox.isErr()) return err(inbox.error);
    const questions: LabQuestion[] = (inbox.value.panes ?? [])
      .filter((i) => i.paneId === pane)
      .map(({ question: q }) => ({
        id: q.id,
        source: q.source,
        prompt: q.prompt,
        ...(q.command ? { command: q.command } : {}),
        ...(q.reason ? { reason: q.reason } : {}),
        options: q.options.map((o) => o.label),
      }));
    const name = pane.replace(/[^A-Za-z0-9._-]+/g, "-");
    const guardFile = join(this.repo, ".metator/guard-asked", `${name}.json`);
    const guard = existsSync(guardFile)
      ? parseJsonDocument(readFileSync(guardFile, "utf8"), guardFile)
          .andThen((raw) => GuardAskedDocument.parse(raw, guardFile))
          .map((d) => d.asked.map((a) => ({ at: a.at, decision: a.decision, reason: a.reason })))
          .unwrapOr([])
      : [];
    const consentFile = join(this.repo, ".metator/consents", `${name}.json`);
    const now = new Date().toISOString();
    const consents = existsSync(consentFile)
      ? {
          writtenAt: statSync(consentFile).mtime.toISOString(),
          kinds: parseJsonDocument(readFileSync(consentFile, "utf8"), consentFile)
            .andThen((raw) => GuardConsentsDocument.parse(raw, consentFile))
            .map((d) => d.consents.filter((c) => c.expiresAt > now).map((c) => c.kind))
            .unwrapOr([]),
        }
      : { kinds: [] };
    const sessionId = seen?.process.sessionId ?? seen?.live?.sessionId;
    return ok({
      ...(seen
        ? {
            pane: {
              id: seen.id,
              alive: seen.live?.alive === true,
              ...(seen.paused ? { paused: seen.paused.why } : {}),
              ...(seen.state ? { state: seen.state.state, reason: seen.state.reason } : {}),
              ...(sessionId ? { sessionId } : {}),
              ...(seen.live?.lastHookAt ? { lastHookAt: seen.live.lastHookAt } : {}),
            },
          }
        : {}),
      screen: shown.isOk() ? (shown.value.text ?? "") : "",
      questions,
      guard,
      consents,
      git,
      files,
    });
  }

  async save(name: string, text: string): Promise<Result<string, MetatorError>> {
    try {
      mkdirSync(this.out, { recursive: true });
      const file = join(this.out, name);
      writeFileSync(file, text);
      const rel = relative(this.o.root, file);
      return ok(rel.startsWith("..") || isAbsolute(rel) ? file : rel);
    } catch (e) {
      return err(
        new MetatorError("COMMAND_FAILED", `could not write ${name} to ${this.out}: ${(e as Error).message}`),
      );
    }
  }

  async close(keep: boolean): Promise<Result<{ readonly kept?: string }, MetatorError>> {
    process.off("SIGINT", this.interrupted);
    process.off("SIGTERM", this.interrupted);
    if (this.daemon) {
      const { proc } = this.daemon;
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(8_000)]);
      this.stop("SIGKILL");
    }
    if (this.dir) killUnder(this.dir);
    if (!this.dir || keep) return ok(this.dir ? { kept: this.repo } : {});
    rmSync(this.dir, { recursive: true, force: true });
    return ok({});
  }

  /** The daemon of the repository, started and listening; `restore: false` leaves its panes paused. */
  private async start(restore: boolean): Promise<Result<void, MetatorError>> {
    const proc = Bun.spawn(
      [
        ...this.o.metator,
        "serve",
        "--port",
        "0",
        "--poll-ms",
        "300",
        "--supervise-ms",
        "700",
        "--screens-ms",
        "1000",
        ...(restore ? [] : ["--no-restore"]),
      ],
      { cwd: this.repo, env: this.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const reader = proc.stderr.getReader();
    const log = join(this.dir, "daemon.log");
    let seen = "";
    const deadline = Date.now() + 60_000;
    let url: string | undefined;
    while (!url) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null),
      ]);
      if (!next || next.done) break;
      seen += new TextDecoder().decode(next.value);
      const line = seen.split("\n").find((l) => l.includes('"serving"'));
      if (line) url = (JSON.parse(line) as { serving: { url: string } }).serving.url;
    }
    writeFileSync(log, seen, { flag: "a" });
    if (!url) {
      proc.kill("SIGKILL");
      return err(new MetatorError("COMMAND_FAILED", `the daemon did not start: ${seen.slice(-600)}`));
    }
    // Its stderr kept in the throwaway directory (a look with --keep), never a full pipe.
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        if (value) writeFileSync(log, value, { flag: "a" });
      }
    })();
    this.daemon = { proc, url };
    return ok(undefined);
  }

  /** The daemon and every process it started (the hosts in its panes) stopped with a signal. */
  private stop(signal: "SIGKILL" | "SIGTERM"): Result<void, MetatorError> {
    const daemon = this.daemon;
    if (!daemon) return ok(undefined);
    const tree = descendants(daemon.proc.pid);
    daemon.proc.kill(signal);
    for (const pid of tree) {
      try {
        process.kill(pid, signal);
      } catch {}
    }
    killUnder(this.repo);
    this.daemon = undefined;
    return ok(undefined);
  }

  /** Types into a pane through its socket, as a person's keyboard: the words, then Enter as its own write. */
  private async type(pane: string, text: string, enter: boolean): Promise<Result<void, MetatorError>> {
    const daemon = this.daemon;
    if (!daemon) return err(MetatorError.usage("no daemon runs"));
    const url = `${daemon.url.replace(/^http/, "ws")}/ws/pane/${encodeURIComponent(pane)}?by=${encodeURIComponent(this.user)}`;
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      let refused: string | undefined;
      const done = setTimeout(() => {
        ws.close();
        resolve(err(new MetatorError("COMMAND_FAILED", `pane ${pane}: its socket did not open`)));
      }, 15_000);
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as {
          type?: string;
          reason?: string;
          error?: { message?: string };
        };
        if (msg.type === "refused") refused = msg.reason;
        if (msg.type === "error") refused = msg.error?.message;
      };
      ws.onopen = async () => {
        ws.send(JSON.stringify({ type: "input", data: text }));
        await Bun.sleep(400);
        if (enter) ws.send(JSON.stringify({ type: "input", data: "\r" }));
        await Bun.sleep(400);
        clearTimeout(done);
        ws.close();
        resolve(
          refused ? err(new MetatorError("TRANSITION_DENIED", `pane ${pane}: ${refused}`)) : ok(undefined),
        );
      };
      ws.onerror = () => {
        clearTimeout(done);
        resolve(err(new MetatorError("COMMAND_FAILED", `pane ${pane}: its socket failed`)));
      };
    });
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Result<T, MetatorError>> {
    const daemon = this.daemon;
    if (!daemon) return err(MetatorError.usage("no daemon runs"));
    try {
      const response = await fetch(`${daemon.url}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      const envelope = (await response.json()) as {
        ok?: boolean;
        data?: T;
        error?: { code?: string; message?: string };
      };
      return envelope.ok && envelope.data !== undefined
        ? ok(envelope.data)
        : err(
            new MetatorError(
              "COMMAND_FAILED",
              `${method} ${path}: ${envelope.error?.message ?? `HTTP ${response.status}`}`,
            ),
          );
    } catch (e) {
      return err(new MetatorError("COMMAND_FAILED", `${method} ${path}: ${(e as Error).message}`));
    }
  }

  /** A command in the repository, its stdout when it succeeds. */
  private run(argv: readonly string[]): Result<string, MetatorError> {
    const r = Bun.spawnSync([...argv], { cwd: this.repo, env: this.env, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString().trim();
    return r.exitCode === 0
      ? ok(out)
      : err(
          new MetatorError(
            "COMMAND_FAILED",
            `${argv.join(" ")} exited ${r.exitCode}: ${`${out}\n${r.stderr}`.trim().slice(-800)}`,
          ),
        );
  }

  /** `metator <args>` in the repository: its envelope's data, or its error. */
  private metator<T>(args: readonly string[]): Result<T, MetatorError> {
    const r = Bun.spawnSync([...this.o.metator, ...args], {
      cwd: this.repo,
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const line =
      r.stdout
        .toString()
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .at(-1) ?? "{}";
    const envelope = JSON.parse(line) as { ok?: boolean; data?: T; error?: { message?: string } };
    return envelope.ok && envelope.data !== undefined
      ? ok(envelope.data)
      : err(
          new MetatorError(
            "COMMAND_FAILED",
            `metator ${args.slice(0, 2).join(" ")}: ${envelope.error?.message ?? r.stderr.toString().slice(-400)}`,
          ),
        );
  }
}

interface PaneSeen {
  readonly id: string;
  readonly paused?: { readonly why: string };
  readonly process: { readonly sessionId?: string };
  readonly live?: { readonly alive: boolean; readonly sessionId?: string; readonly lastHookAt?: string };
  readonly state?: { readonly state: string; readonly reason: string };
}

interface QuestionSeen {
  readonly id: string;
  readonly source: "agent" | "permission";
  readonly prompt: string;
  readonly command?: string;
  readonly reason?: string;
  readonly options: readonly { readonly label: string }[];
}

const quote = (word: string) => `'${word.replace(/'/g, "'\\''")}'`;

/** Every process below `pid`, from `ps` (Linux and macOS alike). */
function descendants(pid: number): number[] {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.toString().split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const c of children.get(p) ?? []) {
      out.push(c);
      walk(c);
    }
  };
  walk(pid);
  return out;
}

/** Every process whose directory is under `dir` (Linux: `/proc`), stopped: none outlives the suite. */
function killUnder(dir: string): void {
  if (!existsSync("/proc")) return;
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    if (Number(pid) === process.pid) continue;
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
      if (cwd === dir || cwd.startsWith(`${dir}/`)) process.kill(Number(pid), "SIGKILL");
    } catch {}
  }
}

/**
 * How this program gives the suite its lab (the `ConformanceLab` port): the daemon it starts and
 * the commands it runs are this program, run the way it was run.
 */
export const conformanceLab =
  (
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): NonNullable<BootstrapOptions["conformanceLab"]> =>
  ({ root }) =>
    new DaemonLab({ metator: [process.execPath, process.argv[1] as string], env, root });
