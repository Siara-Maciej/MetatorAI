/**
 * The quick way (ADR-0093), with the real `metator` process, a real daemon and real PTYs on the
 * scenario host only: `quick check` decides without a model; `quick start` refuses while an
 * escalator trips unless the person keeps it quick in a sentence, and asks where on a dirty
 * checkout; an `mt-quick` run is carried by its conductor in a pane with a visible worker; the
 * real diff past the limits is one card (`This grew past quick`), the end is one card (`Quick
 * change ready: look at the diff`); nothing is committed; `Fine` on a run nothing carries ends it
 * without a drive; `Continue as full` hands the change to a full run and closes the quick one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const QUICK = await Bun.file(join(import.meta.dir, "..", ".github/metator/workflows/mt-quick.yml")).text();
const FEATURE = `kind: Workflow
schemaVersion: 2
id: mt-feature
stages:
  - id: plan
    owner: mt-planner
`;
const CONFIG = `kind: MetatorConfig
schemaVersion: 13
supervisor:
  hostOrder: [scenario]
gates:
  quick:
    - id: check
      run: { script: check }
`;
// The conductor of the quick run does what a model would do in its pane, command by command; the
// implementer changes one source file no test reaches (the escalator the diff trips). The
// conductor of any other run (the full run that continues a quick one) only says so.
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-orchestrator:
    - - say: "conducting {cwd}"
      - run: 'case "$METATOR_RUN" in *round-prices*) ;; *) echo "another run: nothing scripted"; sleep 300;; esac'
      - run: 'metator run delegate build --run "$METATOR_RUN" --agent mt-implementer --card "Add a half-up rate helper in src/rate.ts"'
      - run: 'metator run wait mt-implementer-1 --run "$METATOR_RUN" --timeout 60000'
      - run: 'metator run collect mt-implementer-1 --run "$METATOR_RUN"'
      - run: 'metator run advance pass --run "$METATOR_RUN"'
      - run: 'metator gate quick --base HEAD'
      - run: 'metator run advance pass --run "$METATOR_RUN"'
      - run: 'metator quick check --diff'
      - run: 'metator quick fit --run "$METATOR_RUN" --wait 60000'
      - run: 'metator run advance pass --run "$METATOR_RUN"'
      - write: { path: "{runDir}/quick-review.md", text: "No blocking finding.\\n" }
      - run: 'metator quick reviewed --run "$METATOR_RUN"'
      - run: 'metator run advance pass --run "$METATOR_RUN"'
      - run: 'metator quick ready --run "$METATOR_RUN" --wait 60000'
      - say: "quick run done"
      - ask: { question: "Anything else?", options: [no] }
  mt-implementer:
    - - say: "rounding half-up"
      - write: { path: "{cwd}/src/rate.ts", text: "export const rate = (n: number) => Math.round(n);\\n" }
      - write: { path: "{runDir}/build-log.md", text: "rate.ts rounds half-up\\n" }
      - run: 'metator run result --run "$METATOR_RUN" --worker "$METATOR_WORKER" --status done --summary "rate.ts rounds half-up" --artifact build-log.md'
      - ask: { question: "Anything else?", options: [no] }
`;

let repo: ScratchRepo;
let bin: string;
let env: Record<string, string>;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
type Data = Record<string, unknown>;
interface Q {
  id: string;
  prompt: string;
  source: string;
  agent?: string;
  options: { label: string }[];
  answer?: { choices: string[]; by: string };
}
const mt = (...args: string[]) => metator(args, repo.root, env);
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const error = (r: { json: Record<string, unknown> }) =>
  r.json.error as { code: string; message: string; hint?: string; details?: Data };
const api = async (path: string, init?: RequestInit) =>
  (await (await fetch(`${base}${path}`, init)).json()) as { ok: boolean; data: Data; error?: Data };
const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });
const statusOf = async (runId: string) =>
  data(await mt("run", "status", "--run", runId)) as { status: string; stage: string };
const activity = async (runId: string) =>
  (await repo.read(`.metator/runs/${runId}/activity.jsonl`))
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => (JSON.parse(l) as { text: string }).text);
async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
const cardFor = (runId: string, starts: string) =>
  until(`the card "${starts}"`, async () => {
    const inbox = (await api("/inbox")).data as { decisions: { runId: string; question: Q }[] };
    return inbox.decisions.find((d) => d.runId === runId && d.question.prompt.startsWith(starts))?.question;
  });
/** `run drive` processes working in this repository. */
const drives = () =>
  new TextDecoder()
    .decode(Bun.spawnSync(["ps", "-eo", "args"]).stdout)
    .split("\n")
    .filter((l) => l.includes("run drive") && l.includes(repo.root));

beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  await chmod(join(bin, "metator"), 0o755);
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\nscenario.yml\n");
  await repo.write(
    "package.json",
    JSON.stringify({ name: "shop", private: true, scripts: { check: "true" } }),
  );
  await repo.write("metator.config.yml", CONFIG);
  await repo.write(".github/metator/workflows/mt-quick.yml", QUICK);
  await repo.write(".github/metator/workflows/mt-feature.yml", FEATURE);
  await repo.write("src/price.ts", "export const price = (n: number) => n;\n");
  await repo.write(
    "src/tax.ts",
    'import { price } from "./price.ts";\nexport const tax = (n: number) => price(n) * 0.23;\n',
  );
  await repo.write(
    "test/tax.test.ts",
    'import { tax } from "../src/tax.ts";\nif (tax(100) !== 23) throw new Error("tax");\n',
  );
  for (let i = 0; i < 6; i++) await repo.write(`docs/note-${i}.md`, `note ${i}\n`);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = {
    METATOR_USER: "ana",
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: repo.root,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = daemon.stderr.getReader();
  let text = "";
  base = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
}, 60_000);
afterAll(async () => {
  daemon.kill("SIGTERM");
  await daemon.exited;
  stopProcessesUnder(repo.root);
  await repo.dispose();
  await rm(bin, { recursive: true, force: true });
});

describe("metator quick check: is the change small enough, without a model", () => {
  test("a tested file is quick; each escalator says why and which tool saw it; the thresholds are the config's", async () => {
    const quick = await mt("quick", "check", "--files", "src/price.ts");
    expect([quick.code, data(quick)]).toEqual([
      0,
      {
        quick: true,
        escalators: [],
        thresholds: { maxFiles: 5, maxLines: 150, maxDependents: 10 },
        files: ["src/price.ts"],
      },
    ]);
    // Reported, never a failure: the caller decides what a tripped escalator means.
    const many = await mt(
      "quick",
      "check",
      "--files",
      [0, 1, 2, 3, 4, 5].map((i) => `docs/note-${i}.md`).join(","),
    );
    expect([many.code, data(many).quick, data(many).escalators]).toEqual([
      0,
      false,
      [{ id: "size", why: "6 files (limit 5)", source: "git diff" }],
    ]);
    const words = data(await mt("quick", "check", "--task", "Add a migration, see src/tax.ts"));
    expect([
      words.files,
      (words.escalators as { id: string; source: string }[]).map((e) => [e.id, e.source]),
    ]).toEqual([["src/tax.ts"], [["migration", "the task's words"]]]);
    const nothing = await mt("quick", "check");
    expect([nothing.code, error(nothing).code]).toEqual([64, "USAGE"]);
  });
});

describe("metator quick start: refusals before anything starts", () => {
  test("escalators refuse it with which; a dirty checkout asks where; nothing was started", async () => {
    const six = [0, 1, 2, 3, 4, 5].map((i) => `docs/note-${i}.md`).join(",");
    const refused = await mt("quick", "start", "--task", "Reword the notes", "--files", six);
    expect([refused.code, error(refused).message, error(refused).details]).toEqual([
      64,
      'not quick: size (6 files (limit 5)). The person may keep it quick with one sentence (--override "<their words>").',
      { escalators: [{ id: "size", why: "6 files (limit 5)", source: "git diff" }] },
    ]);
    await repo.write("docs/note-0.md", "note 0, edited by hand\n");
    const dirty = await mt("quick", "start", "--task", "Round prices half-up");
    expect([dirty.code, error(dirty).message]).toEqual([64, "dirty: pass --here or --worktree"]);
    expect(error(dirty).hint).toContain("docs/note-0.md");
    await repo.git("checkout", "--", "docs/note-0.md");
    expect((await mt("run", "list")).json.data).toEqual([]);
  });
});

describe("an mt-quick run, carried by its conductor in a pane (scenario host)", () => {
  let runId = "";

  test("quick start opens the conductor session; the worker works in its own pane; the diff past the limits is one card", async () => {
    const started = await mt("quick", "start", "--task", "Round prices half-up");
    expect(started.code).toBe(0);
    const s = data(started) as {
      runId: string;
      workflow: string;
      session?: { paneId: string; host: string };
    };
    runId = s.runId;
    expect([s.workflow, s.session?.host, runId.includes("mt-quick")]).toEqual(["mt-quick", "scenario", true]);
    // The worker's pane is there to see, beside the conductor's.
    const panes = await until("the worker's pane", async () => {
      const all = (
        (await api("/layout")).data as {
          panes: { role: string; runId?: string; worker?: { name: string } }[];
        }
      ).panes;
      return all.some((p) => p.worker?.name === "mt-implementer-1") ? all : undefined;
    });
    expect(panes.filter((p) => p.runId === runId).map((p) => p.worker?.name ?? p.role)).toEqual([
      "conductor",
      "mt-implementer-1",
    ]);
    // The real diff: a source file no test reaches. One card; the run waits at `fit`.
    const grew = await cardFor(runId, "This grew past quick");
    expect([grew.prompt, grew.source, grew.agent, grew.options.map((o) => o.label)]).toEqual([
      "This grew past quick: untested (no test reaches src/rate.ts)",
      "agent",
      "metator",
      ["Continue as full", "Keep as quick", "Other"],
    ]);
    expect((await statusOf(runId)).stage).toBe("fit");
    expect(drives()).toEqual([]);
  }, 120_000);

  test("Keep as quick is recorded with who said it; the run ends with one card and an uncommitted diff; Fine ends it, no drive", async () => {
    const grew = await cardFor(runId, "This grew past quick");
    expect(
      (await post(`/runs/${runId}/answer`, { question: grew.id, choices: ["Keep as quick"], by: "ana" })).ok,
    ).toBe(true);
    const ready = await cardFor(runId, "Quick change ready");
    expect([ready.prompt, ready.options.map((o) => o.label)]).toEqual([
      "Quick change ready: look at the diff",
      ["Open diff", "Fine", "Other"],
    ]);
    expect(await activity(runId)).toContain(
      "quick although untested (no test reaches src/rate.ts): ana keeps it quick",
    );
    // The run still stands at its last stage while the card is open; the change is in the tree, uncommitted.
    expect(await statusOf(runId)).toMatchObject({ status: "active", stage: "ready" });
    expect((await repo.git("status", "--porcelain")).trim()).toBe("?? src/rate.ts");
    expect((await repo.git("log", "--oneline")).trim().split("\n")).toHaveLength(1);
    expect(
      (await post(`/runs/${runId}/answer`, { question: ready.id, choices: ["Fine"], by: "ana" })).ok,
    ).toBe(true);
    await until("the run to be done", async () =>
      (await statusOf(runId)).status === "done" ? true : undefined,
    );
    expect((await repo.git("status", "--porcelain")).trim()).toBe("?? src/rate.ts");
    expect(drives()).toEqual([]);
    await rm(repo.path("src/rate.ts"));
  }, 120_000);
});

describe("metator quick start --override: the person keeps it quick in one sentence", () => {
  test("the run starts although an escalator tripped; the sentence is recorded with the run, in the person's words", async () => {
    const six = [0, 1, 2, 3, 4, 5].map((i) => `docs/note-${i}.md`).join(",");
    const started = await mt(
      "quick",
      "start",
      "--task",
      "Reword the six notes",
      "--files",
      six,
      "--override",
      "they are six one-line notes, keep it quick",
    );
    expect(started.code).toBe(0);
    const s = data(started) as { runId: string; overridden: string[]; check: { quick: boolean } };
    expect([s.overridden, s.check.quick]).toEqual([["size"], false]);
    expect(await activity(s.runId)).toContain(
      'quick although size (6 files (limit 5)): the person keeps it quick: "they are six one-line notes, keep it quick"',
    );
    const kept = JSON.parse(await repo.read(`.metator/runs/${s.runId}/quick.json`)) as Data;
    expect(kept).toMatchObject({
      kind: "QuickRun",
      schemaVersion: 1,
      overrides: [
        { escalators: ["size"], by: "the person", words: "they are six one-line notes, keep it quick" },
      ],
    });
    expect((await mt("run", "close", "--run", s.runId, "--aborted", "--reason", "only shown")).code).toBe(0);
  }, 60_000);
});

describe("a quick run nothing carries (no session, no drive)", () => {
  const atStage = async (stage: string, task: string) => {
    const runId = data(await mt("run", "init", "--workflow", "mt-quick", "--task", task)).runId as string;
    for (;;) {
      if ((await statusOf(runId)).stage === stage) return runId;
      expect((await mt("run", "advance", "pass", "--run", runId)).code).toBe(0);
    }
  };

  test("quick ready says not yet (exit 4) until the person answers; Fine ends the run where it is answered, and no drive starts", async () => {
    const runId = await atStage("ready", "Reword one note");
    const waiting = await mt("quick", "ready", "--run", runId);
    expect([waiting.code, error(waiting).code, error(waiting).message]).toEqual([
      4,
      "WAITING",
      'waiting for the person: "Quick change ready: look at the diff" (q001)',
    ]);
    // Asked once, however often the gate looks.
    await mt("quick", "ready", "--run", runId);
    const card = await cardFor(runId, "Quick change ready");
    expect(card.id).toBe("q001");
    const answered = await post(`/runs/${runId}/answer`, { question: "q001", choices: ["Fine"], by: "ana" });
    expect([answered.ok, (answered.data as { drive?: unknown }).drive]).toEqual([true, undefined]);
    expect((await statusOf(runId)).status).toBe("done");
    expect(drives()).toEqual([]);
    const fine = await mt("quick", "ready", "--run", runId);
    expect([fine.code, data(fine)]).toEqual([
      0,
      { runId, state: "fine", by: "ana", run: "done", next: `Run ${runId} is done: do not advance it.` },
    ]);
  }, 60_000);

  test("the review's gate reads the reviewer's file: a blocking finding fails it and the run goes back to build, once", async () => {
    const runId = await atStage("review", "Rename one helper");
    const file = `.metator/runs/${runId}/quick-review.md`;
    await repo.write(file, "BLOCKING: 1\nsrc/price.ts:1 returns the old value\n\nNotes:\n- naming\n");
    const blocked = await mt("quick", "reviewed", "--run", runId);
    expect([blocked.code, error(blocked).code, error(blocked).message]).toEqual([
      1,
      "CHECK_FAILED",
      "the review has 1 blocking finding(s): src/price.ts:1 returns the old value",
    ]);
    const back = data(await mt("run", "advance", "fail", "--run", runId, "--reason", "1 blocking finding"));
    expect([back.stage, back.status]).toEqual(["build", "active"]);
    // Fixed and reviewed again: the gate passes. A second blocking review would stop the run for the person.
    for (const _ of ["build", "gate", "fit"]) await mt("run", "advance", "pass", "--run", runId);
    await repo.write(file, "No blocking finding.\n");
    const passed = await mt("quick", "reviewed", "--run", runId);
    expect([passed.code, data(passed)]).toEqual([0, { blocking: 0, file }]);
    await mt("run", "advance", "fail", "--run", runId, "--reason", "still blocking");
    expect(await statusOf(runId)).toMatchObject({ status: "escalated" });
    expect((await mt("run", "close", "--run", runId, "--aborted", "--reason", "only shown")).code).toBe(0);
  }, 60_000);

  test("Continue as full: a full run takes the diff over in its own conductor session, and the quick run is closed with where it went", async () => {
    const runId = await atStage("fit", "Reword the notes");
    for (let i = 0; i < 6; i++) await repo.write(`docs/note-${i}.md`, `note ${i}, reworded\n`);
    const waiting = await mt("quick", "fit", "--run", runId);
    expect([waiting.code, error(waiting).message]).toEqual([
      4,
      'waiting for the person: "This grew past quick: size (6 files (limit 5))" (q001)',
    ]);
    expect((await mt("run", "answer", "q001", "--run", runId, "--choice", "Continue as full")).code).toBe(0);
    const moved = await mt("quick", "fit", "--run", runId);
    expect(moved.code).toBe(0);
    const full = data(moved) as { state: string; run: string; workflow: string; next: string };
    expect([full.state, full.workflow, full.run.includes("mt-feature")]).toEqual([
      "full",
      "mt-feature",
      true,
    ]);
    expect(full.next).toBe(
      `Quick run ${runId} is closed: run ${full.run} (mt-feature) continues the change in its own conductor session. Do nothing more for ${runId}.`,
    );
    const quick = data(await mt("run", "status", "--run", runId)) as { status: string };
    expect(quick.status).toBe("aborted");
    expect(await repo.read(`.metator/runs/${runId}/log.md`)).toContain(
      `ABORT · continued as full: run ${full.run}`,
    );
    const record = JSON.parse(await repo.read(`.metator/runs/${full.run}/state.json`)) as { task: string };
    expect(record.task).toContain(`continues quick run ${runId}`);
    // The diff stays where it was: the full run works on top of it, in a pane of its own.
    expect((await repo.git("status", "--porcelain")).trim().split("\n")).toHaveLength(6);
    const panes = ((await api("/layout")).data as { panes: { role: string; runId?: string }[] }).panes;
    expect(panes.some((p) => p.runId === full.run && p.role === "conductor")).toBe(true);
    expect(drives()).toEqual([]);
  }, 60_000);
});
