import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem, InstantTimer } from "@metator/testing";
import {
  CONFORMANCE_REFUSAL,
  ConformanceHistory,
  RunHostConformance,
  readConformance,
} from "../src/application/host-conformance.ts";
import type { LabAction, LabGuardRecord, LabQuestion, LabView } from "../src/domain/conformance-lab.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { CONFORMANCE_CHECK_IDS, HostConformanceDocument } from "../src/domain/host-conformance.ts";
import { err, ok, type Result } from "../src/domain/result.ts";
import { serializeJsonDocument } from "../src/domain/versioned.ts";
import type { ConformanceLab } from "../src/ports/index.ts";

/** Ways a host can fall short of the suite, each breaking what one check proves. */
type Fault =
  | "forget-on-resume"
  | "new-session-on-resume"
  | "ignore-deny"
  | "no-ask"
  | "no-consent"
  | "prompt-allowed"
  | "no-text-question"
  | "no-thread"
  | "ignore-tell"
  | "ignore-interrupt"
  | "placeholder-session"
  | "never-rests"
  | "trust-first"
  /** Takes a while before it shows it heard anything (its screen unchanged, idle). */
  | "slow-start";

interface Pane {
  readonly id: string;
  alive: boolean;
  paused?: string | undefined;
  sessionId: string;
  readonly screen: string[];
  busy: number;
  counting?: number | undefined;
  trusting: boolean;
  readonly questions: LabQuestion[];
  readonly guard: LabGuardRecord[];
  consents: { writtenAt?: string; kinds: string[] };
  memory?: string | undefined;
  lastHookAt?: string;
  colour?: boolean;
  /** Looks left before a slow host shows what it heard. */
  lag?: number;
  pending?: () => void;
}

const REPO = "/tmp/metator-conformance-claude-x1/conformance-ab12";
const PERSON = "[metator] From the person (ana): ";

/**
 * A host as the suite sees it through the lab, played in memory: a conforming one, unless a fault
 * makes it fall short of one check. It answers the suite's own words the way an agent would.
 */
class FakeLab implements ConformanceLab {
  readonly calls: LabAction[] = [];
  readonly saved = new Map<string, string>();
  closed: boolean[] = [];
  opened = 0;
  private readonly panes = new Map<string, Pane>();
  private title = "";
  private readonly files = new Map<string, string>([["README.md", "# repo\n"]]);
  private readonly staged = new Set<string>();
  private git = { commits: 2, subject: "setup" };
  private q = 0;
  failOpen = false;

  constructor(
    private readonly clock: FixedClock,
    private readonly faults: ReadonlySet<Fault> = new Set(),
  ) {}

  private now = () => this.clock.now().toISOString();

  async open(): Promise<Result<{ readonly repo: string; readonly os: string }, MetatorError>> {
    this.opened++;
    return this.failOpen ? err(MetatorError.usage("setup failed")) : ok({ repo: REPO, os: "test os" });
  }

  async act(a: LabAction): Promise<Result<{ readonly pane?: string }, MetatorError>> {
    this.calls.push(a);
    if (a.kind === "session") {
      const id = `w1:p${this.panes.size + 1}`;
      const pane: Pane = {
        id,
        alive: true,
        sessionId: this.faults.has("placeholder-session") ? "continue" : `5e1d${this.panes.size}-uuid`,
        screen: [],
        busy: 1,
        trusting: this.faults.has("trust-first") && this.panes.size === 0,
        questions: [],
        guard: [],
        consents: { kinds: [] },
      };
      this.panes.set(id, pane);
      if (a.session === "chat") this.title = a.title ?? "";
      if (pane.trusting)
        pane.screen.push(
          " Do you trust the files in this folder?",
          ` ${REPO}`,
          " ❯ 1. Yes, proceed",
          "   2. No, exit",
        );
      else pane.screen.push(a.session === "chat" ? "● Hello." : "● Ready.", "❯");
      return ok({ pane: id });
    }
    if (a.kind === "restart") {
      for (const p of this.panes.values())
        if (p.alive) Object.assign(p, { alive: false, paused: "daemon-stopped" });
      return ok({});
    }
    if (a.kind === "write") {
      this.files.set(a.path, a.text);
      if (a.stage) this.staged.add(a.path);
      return ok({});
    }
    const p = this.panes.get(a.pane);
    if (!p) return err(MetatorError.notFound(`pane ${a.pane}`));
    if (a.kind === "continue") {
      Object.assign(p, { alive: true, paused: undefined, busy: 1 });
      if (this.faults.has("new-session-on-resume")) p.sessionId = `${p.sessionId}-new`;
      if (this.faults.has("forget-on-resume")) p.memory = undefined;
      p.screen.push("● Resumed.", "❯");
      return ok({});
    }
    if (a.kind === "type") {
      if (p.trusting) {
        p.trusting = a.text !== "1";
        p.screen.push("● Hello.", "❯");
        return ok({});
      }
      if (this.faults.has("slow-start")) {
        const text = a.text;
        Object.assign(p, { lag: 6, pending: () => this.hear(p, text) });
      } else this.hear(p, a.text);
      return ok({});
    }
    if (a.kind === "tell") {
      if (!this.faults.has("ignore-tell")) this.hear(p, `${PERSON}${a.text}`);
      return ok({});
    }
    if (a.kind === "interrupt") {
      if (!this.faults.has("ignore-interrupt")) p.counting = undefined;
      this.hear(p, a.text);
      return ok({});
    }
    if (a.kind !== "answer") return ok({});
    const q = p.questions.find((x) => x.id === a.question);
    if (!q) return err(MetatorError.notFound(`question ${a.question}`));
    p.questions.splice(p.questions.indexOf(q), 1);
    p.busy = 1;
    if (q.source === "agent")
      p.screen.push(
        `❯ ${a.choice.slice(0, 1)}`,
        `● COLOUR-${a.choice.includes("blue") ? "BLUE" : "RED"}`,
        "❯",
      );
    else if (/^yes/i.test(a.choice)) this.commit(p, "approved");
    else p.screen.push("● Not run: the person said no.", "❯");
    return ok({});
  }

  /** The agent: the suite's words, acted on. */
  private hear(p: Pane, said: string): void {
    p.busy = 1;
    p.screen.push(`❯ ${said}`);
    const text = said.startsWith(PERSON) ? said.slice(PERSON.length) : said;
    const say = (line: string) => p.screen.push(`● ${line}`);
    const tool = (command: string, run: () => void) => {
      p.lastHookAt = this.now();
      say(`Bash(${command})`);
      run();
    };
    const upper = /uppercase form of this word: (\w+)/.exec(text)?.[1];
    if (/Remember this code word[^:]*: (\w+)/.test(text)) {
      p.memory = /: (\w+)/.exec(text)?.[1];
      say("OK");
    } else if (/What is the code word/.test(text)) say(p.memory ? p.memory.toUpperCase() : "I do not know.");
    else if (text.includes("`git reset --hard`")) {
      tool("git reset --hard", () => {
        if (this.faults.has("ignore-deny")) this.files.set("README.md", "# repo\n");
        else p.guard.push({ at: this.now(), decision: "deny", reason: "`git reset --hard` never runs here" });
      });
    } else if (/`git commit -m "([^"]+)"`/.test(text)) {
      const command = `git commit -m "${/`git commit -m "([^"]+)"`/.exec(text)?.[1]}"`;
      tool(command, () => {
        if (this.faults.has("no-ask")) return this.commit(p, "conformance ask");
        p.guard.push({ at: this.now(), decision: "ask", reason: `\`${command}\` needs your consent` });
        p.questions.push({
          id: `p${++this.q}`,
          source: "permission",
          prompt: `${command} — This command requires approval`,
          command,
          reason: `\`${command}\` needs your consent`,
          options: [
            "Yes",
            "No, and tell Claude what to do differently (esc)",
            "Attach and answer in the pane",
            "Leave it",
          ],
        });
      });
    } else if (/^commit it, with the message "([^"]+)"/.test(text)) {
      const subject = /"([^"]+)"/.exec(text)?.[1] ?? "";
      if (!this.faults.has("no-consent")) p.consents = { writtenAt: this.now(), kinds: ["commit"] };
      tool(`git commit -m "${subject}"`, () => {
        if (p.consents.kinds.includes("commit")) {
          p.consents.kinds = [];
          this.commit(p, subject);
        } else this.ask(p, `git commit -m "${subject}"`);
      });
    } else if (text.includes("`metator rules list`")) {
      tool("metator rules list", () =>
        this.faults.has("prompt-allowed") ? this.ask(p, "metator rules list") : undefined,
      );
      tool("git status", () => undefined);
      say(upper?.toUpperCase() ?? "?");
    } else if (text.includes("which colour I prefer")) {
      if (this.faults.has("no-text-question")) say("COLOUR-BLUE? I chose for you.");
      else {
        say("Which colour do you prefer?");
        p.screen.push("  a) red", "  b) blue");
        p.questions.push({
          id: `p${++this.q}`,
          source: "agent",
          prompt: "Which colour do you prefer?",
          options: ["a) red", "b) blue", "Other", "Leave it"],
        });
      }
    } else if (text.includes("`metator thread show`")) {
      tool("metator thread show", () => undefined);
      say(this.faults.has("no-thread") ? "I could not read it." : this.title.toUpperCase());
    } else if (/Write the numbers from 1 to (\d+)/.test(text)) p.counting = 0;
    else if (upper) say(upper.toUpperCase());
    else say("Done.");
    if (p.counting === undefined) p.screen.push("❯");
  }

  private ask(p: Pane, command: string): void {
    p.questions.push({
      id: `p${++this.q}`,
      source: "permission",
      prompt: `${command} — This command requires approval`,
      command,
      options: ["Yes", "No"],
    });
  }

  private commit(p: Pane, subject: string): void {
    this.git = { commits: this.git.commits + 1, subject };
    this.staged.clear();
    p.screen.push(`● [main abc123] ${subject}`, "❯");
  }

  async look(input: {
    readonly pane?: string;
    readonly files: readonly string[];
  }): Promise<Result<LabView, MetatorError>> {
    const p = input.pane ? this.panes.get(input.pane) : undefined;
    let state = "idle";
    if (p?.lag) {
      p.lag--;
      if (p.lag === 0) p.pending?.();
    }
    if (p) {
      if (p.lag) state = "idle";
      else if (!p.alive) state = "exited";
      else if (p.trusting || p.questions.some((q) => q.source === "permission")) state = "blocked";
      else if (p.counting !== undefined) {
        state = "working";
        p.screen.push(String(++p.counting));
        if (p.counting >= 40) {
          p.counting = undefined;
          p.screen.push("LIST-END", "❯");
        }
      } else if (p.busy > 0 || this.faults.has("never-rests")) {
        p.busy--;
        state = "working";
      }
    }
    return ok({
      ...(p
        ? {
            pane: {
              id: p.id,
              alive: p.alive,
              ...(p.paused ? { paused: p.paused } : {}),
              state,
              sessionId: p.sessionId,
              ...(p.lastHookAt ? { lastHookAt: p.lastHookAt } : {}),
            },
          }
        : {}),
      screen: p?.screen.join("\n") ?? "",
      questions: p ? [...p.questions] : [],
      guard: p ? [...p.guard] : [],
      consents: p ? { ...p.consents, kinds: [...p.consents.kinds] } : { kinds: [] },
      git: { ...this.git },
      files: Object.fromEntries(input.files.map((f) => [f, this.files.get(f)])),
    });
  }

  async save(name: string, text: string): Promise<Result<string, MetatorError>> {
    this.saved.set(name, text);
    return ok(`.metator/conformance/${name}`);
  }

  async close(keep: boolean): Promise<Result<{ readonly kept?: string }, MetatorError>> {
    this.closed.push(keep);
    return ok(keep ? { kept: REPO } : {});
  }
}

const words = [
  "kavo",
  "lumi",
  "sena",
  "tiro",
  "palu",
  "neko",
  "ribo",
  "doma",
  "fesu",
  "gali",
  "hova",
  "juno",
  "kipe",
];
function world(faults: Fault[] = [], over: { refusal?: string } = {}) {
  const clock = new FixedClock(new Date("2026-11-22T10:00:00.000Z"));
  const lab = new FakeLab(clock, new Set(faults));
  let n = 0;
  const suite = new RunHostConformance({
    lab,
    clock,
    timer: new InstantTimer(() => clock.advance(100), 100_000),
    nonce: () => words[n++ % words.length] as string,
    metatorVersion: "0.0.0-test",
    hosts: ["claude", "copilot", "scenario"],
    refusal: () => over.refusal,
    version: async (host) => (host === "scenario" ? undefined : "2.1.0"),
  });
  const run = (input: Partial<Parameters<RunHostConformance["execute"]>[0]> = {}) =>
    suite.execute({ host: "claude", timeoutMs: 8_000, settleMs: 300, pollMs: 100, ...input });
  return { lab, clock, run };
}
const results = (r: Awaited<ReturnType<ReturnType<typeof world>["run"]>>) =>
  Object.fromEntries(r._unsafeUnwrap().document.checks.map((c) => [c.id, c.result]));

describe("RunHostConformance: every check through what MetatorAI observes", () => {
  test("a conforming host passes every check; the run is a HostConformance document and its report", async () => {
    const w = world();
    const run = (await w.run())._unsafeUnwrap();
    expect(run.document.checks.map((c) => [c.id, c.result, c.evidence.includes("FAIL")])).toEqual(
      CONFORMANCE_CHECK_IDS.map((id) => [id, "pass", false]),
    );
    expect([run.passed, run.failed, run.skipped]).toEqual([11, 0, 0]);
    expect(run.files).toEqual({
      json: ".metator/conformance/conformance-claude-2.1.0.json",
      report: ".metator/conformance/conformance-claude-2.1.0.md",
    });
    const kept = readConformance(
      w.lab.saved.get("conformance-claude-2.1.0.json") as string,
      "x.json",
    )._unsafeUnwrap();
    expect(kept).toEqual(run.document);
    expect([kept.host, kept.cliVersion, kept.os, kept.metatorVersion]).toEqual([
      "claude",
      "2.1.0",
      "test os",
      "0.0.0-test",
    ]);
    expect(w.lab.saved.get("conformance-claude-2.1.0.md")).toContain("11 passed, 0 failed, 0 skipped");
    expect(w.lab.closed).toEqual([false]);
    // The evidence is what was observed.
    const ev = (id: string) => run.document.checks.find((c) => c.id === id)?.evidence ?? "";
    expect(ev("start")).toContain("screen: ● LUMI");
    expect(ev("session-id")).toContain("session id: 5e1d0-uuid");
    expect(ev("resume")).toContain("pane paused (daemon-stopped)");
    expect(ev("resume")).toContain("continued: session 5e1d0-uuid resumed in pane w1:p1");
    expect(ev("hook-pre-tool-deny")).toContain("guard (GuardAsked");
    expect(ev("hook-pre-tool-ask")).toContain('command: git commit -m "conformance ask');
    expect(ev("hook-pre-tool-ask")).toContain("answered in the inbox: No, and tell Claude");
    expect(ev("word-consent")).toContain("the user-prompt hook kept the person's consent (commit)");
    expect(ev("text-question")).toContain("options: a) red | b) blue");
    expect(ev("mcp-or-tools")).toContain("screen: ● CONFORMANCE KAVO");
    expect(ev("tell")).toContain("opened the run session in pane w1:p2");
    expect(ev("interrupt")).toContain('"LIST-END" never came');
    // As a person does: the chat as a thread, words typed and told, the daemon killed and continued.
    const kinds = w.lab.calls.map((c) => c.kind);
    for (const k of ["session", "type", "answer", "tell", "interrupt", "restart", "continue", "write"])
      expect(kinds).toContain(k as LabAction["kind"]);
  });

  test.each([
    ["placeholder-session", ["session-id"]],
    ["new-session-on-resume", ["resume"]],
    ["forget-on-resume", ["resume"]],
    ["ignore-deny", ["hook-pre-tool-deny"]],
    ["no-ask", ["hook-pre-tool-ask"]],
    ["no-consent", ["word-consent"]],
    ["prompt-allowed", ["unprompted-allow"]],
    ["no-text-question", ["text-question"]],
    ["no-thread", ["mcp-or-tools"]],
    // The interrupt check gives its long task by `tell`: a host that does not hear it fails both.
    ["ignore-tell", ["tell", "interrupt"]],
    ["ignore-interrupt", ["interrupt"]],
  ] as const)("a host with %s fails exactly %p, and the suite goes on", async (fault, failing) => {
    const w = world([fault]);
    const got = results(await w.run());
    expect(Object.keys(got)).toEqual([...CONFORMANCE_CHECK_IDS]);
    expect(
      Object.entries(got)
        .filter(([, r]) => r !== "pass")
        .map(([id]) => id),
    ).toEqual([...failing]);
    expect(w.lab.closed).toEqual([false]);
  });

  test("a host prompt no check waits for is answered No and noted; the check that expects none fails", async () => {
    const w = world(["prompt-allowed"]);
    const run = (await w.run({ only: ["start", "unprompted-allow"] }))._unsafeUnwrap();
    const ev = run.document.checks.find((c) => c.id === "unprompted-allow")?.evidence ?? "";
    expect(ev).toContain("the host asked: metator rules list; answered No");
    expect(ev).toContain("FAIL: the host asked: metator rules list");
  });

  test("a session that never rests: its checks fail on their timeout, every check still has a result", async () => {
    const w = world(["never-rests"]);
    const got = (await w.run({ timeoutMs: 2_000 }))._unsafeUnwrap();
    expect(got.document.checks.length).toBe(11);
    expect(got.document.checks[0]?.evidence).toContain(
      "timed out after 2 s waiting for the session to come to rest",
    );
    expect(w.lab.closed).toEqual([false]);
  });

  test("the host's first-run question to trust the throwaway repository is answered, and said", async () => {
    const w = world(["trust-first"]);
    const run = (await w.run({ only: ["start"] }))._unsafeUnwrap();
    expect(run.document.checks[0]?.result).toBe("pass");
    expect(run.document.checks[0]?.evidence).toContain(
      "first run: claude asked to trust the throwaway repository; answered Yes",
    );
    expect(w.lab.calls).toContainEqual({ kind: "type", pane: "w1:p1", text: "1", enter: true });
  });

  test("--only: the others are skipped; a check without its own opening opens the session it needs", async () => {
    const w = world();
    const run = (await w.run({ only: ["resume", "interrupt"] }))._unsafeUnwrap();
    expect(results(ok(run))).toEqual(
      Object.fromEntries(
        CONFORMANCE_CHECK_IDS.map((id) => [id, ["resume", "interrupt"].includes(id) ? "pass" : "skipped"]),
      ),
    );
    expect(run.document.checks.find((c) => c.id === "tell")?.evidence).toBe("not selected (--only)");
    expect(
      w.lab.calls.filter((c) => c.kind === "session").map((c) => (c as { session: string }).session),
    ).toEqual(["chat", "run"]);
  });

  test("a host slow to show it heard: the suite waits until it worked and rested, not at the first idle look", async () => {
    const w = world(["slow-start"]);
    const run = (await w.run({ only: ["start", "resume"] }))._unsafeUnwrap();
    expect(run.document.checks.filter((c) => c.result !== "skipped").map((c) => [c.id, c.result])).toEqual([
      ["start", "pass"],
      ["resume", "pass"],
    ]);
  });

  test("kept when asked: the repository's path comes back", async () => {
    const w = world();
    const run = (await w.run({ only: ["session-id"], keep: true }))._unsafeUnwrap();
    expect(run.kept).toBe(REPO);
    expect(w.lab.closed).toEqual([true]);
  });

  test("refused where no real host may start (METATOR_NO_REAL_HOSTS); nothing is set up", async () => {
    const w = world([], { refusal: "claude is a real AI host" });
    const r = await w.run();
    expect(r._unsafeUnwrapErr().message).toBe(CONFORMANCE_REFUSAL);
    expect(CONFORMANCE_REFUSAL).toBe(
      "the conformance suite drives a real host; unset METATOR_NO_REAL_HOSTS to run it",
    );
    expect(w.lab.opened).toBe(0);
  });

  test("an unknown host or check is a usage error before anything runs", async () => {
    const w = world();
    expect((await w.run({ host: "gemini" }))._unsafeUnwrapErr().message).toBe(
      "no interactive host gemini here",
    );
    expect((await w.run({ only: ["start", "teleport"] }))._unsafeUnwrapErr().message).toBe(
      "no such check: teleport",
    );
    expect(w.lab.opened).toBe(0);
  });

  test("a repository that cannot be set up is the error, and what was made of it is cleaned up", async () => {
    const w = world();
    (w.lab as FakeLab).failOpen = true;
    expect((await w.run())._unsafeUnwrapErr().message).toBe("setup failed");
    expect(w.lab.closed).toEqual([false]);
  });

  test("a host without a version of its own (the scenario host) says so", async () => {
    const w = world();
    const run = (await w.run({ host: "scenario", only: ["session-id"] }))._unsafeUnwrap();
    expect(run.document.cliVersion).toBe("scenario");
    expect(run.files.json).toBe(".metator/conformance/conformance-scenario-scenario.json");
  });
});

describe("ConformanceHistory: the kept runs metator doctor reads", () => {
  const stamp = (host: string, cliVersion: string, endedAt: string, result: "pass" | "fail") =>
    serializeJsonDocument(
      HostConformanceDocument.stamp({
        host,
        cliVersion,
        os: "linux",
        metatorVersion: "0",
        startedAt: endedAt,
        endedAt,
        checks: CONFORMANCE_CHECK_IDS.map((id) => ({ id, title: id, result, evidence: "", tookMs: 1 })),
      }),
    );

  test("each host's last passing run, with the version installed now; unreadable files are passed over", async () => {
    const fs = new InMemoryFileSystem({
      ".metator/conformance/conformance-claude-2.1.0.json": stamp(
        "claude",
        "2.1.0",
        "2026-11-20T10:00:00.000Z",
        "pass",
      ),
      ".metator/conformance/conformance-copilot-1.0.114.json": stamp(
        "copilot",
        "1.0.114",
        "2026-11-21T10:00:00.000Z",
        "fail",
      ),
      ".metator/conformance/broken.json": "{ not json",
      ".metator/conformance/conformance-claude-2.1.0.md": "# report",
    });
    const asked: string[] = [];
    const history = new ConformanceHistory(fs, async (host) => {
      asked.push(host);
      return host === "claude" ? "2.0.0" : undefined;
    });
    expect(await history.seen()).toEqual([
      { host: "claude", passed: { cliVersion: "2.1.0", at: "2026-11-20T10:00:00.000Z" }, installed: "2.0.0" },
      { host: "copilot", last: { cliVersion: "1.0.114", at: "2026-11-21T10:00:00.000Z", failed: 11 } },
    ]);
    expect(asked).toEqual(["claude", "copilot"]);
  });

  test("no runs kept: nothing to say, and no host is asked its version", async () => {
    const asked: string[] = [];
    const history = new ConformanceHistory(new InMemoryFileSystem(), async (h) => {
      asked.push(h);
      return undefined;
    });
    expect(await history.seen()).toEqual([]);
    expect(asked).toEqual([]);
  });
});
