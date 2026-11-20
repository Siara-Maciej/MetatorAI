/**
 * What the demo shows (round 8, real daemon, scenario host only): a system plan starts three
 * child runs in three repositories of a folder; the person opens each, and each gets its own
 * conductor session in its own repository and worktree. Each conductor delegates two workers of
 * its stage that work at the same time, waits for both and collects them: the workers' panes end
 * with their one-line results and stay, the conductors keep working.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";

const APPS = ["billing", "web", "mobile"] as const;
const MAP = `kind: SystemMap
schemaVersion: 2
system: shop
applications:
${APPS.map((a) => `  - { id: ${a}, kind: service, source: { repo: github.com/shop/${a} }, owners: ["@${a}"] }`).join("\n")}
contracts: []
policies: { deployOrder: providers-first, breaking: expand-contract }
`;
// Three steps that do not wait for each other: one wave, three child runs at once.
const PLAN = `kind: SystemPlan
schemaVersion: 1
id: add-a-badge
task: Add a badge
status: draft
createdBy: mt-system-planner
strategies: []
steps:
${APPS.map((a) => `  - { id: ${a}-badge, app: ${a}, summary: Show a badge in ${a}, contracts: [], dependsOn: [], status: pending }`).join("\n")}
`;
const ANALYSIS = `kind: SystemAnalysis
schemaVersion: 1
task: Add a badge
map: docs/metator/system.yml
base: HEAD
contracts: []
applications:
${APPS.map((a) => `  - { id: ${a}, roles: [changed], owners: ["@${a}"], files: [] }`).join("\n")}
`;
// The child's workflow: its build stage lets the conductor start two testers at once.
const FEATURE = `kind: Workflow
schemaVersion: 2
id: mt-feature
limits: { parallel: 2 }
stages:
  - id: build
    owner: mt-implementer
    parallel: [mt-tester]
`;
// The conductor and its workers are scripted: the conductor runs the commands a model would run
// in its pane; each tester waits until both testers have their cards (so they work at the same
// time), writes its part and reports. The drive of each child (mt-implementer) only waits.
const tester = (part: string) => `    - - say: "testing part ${part}"
      - run: 'until [ -f "$METATOR_RUN_DIR/work/mt-tester-2.md" ]; do sleep 0.1; done'
      - write: { path: "{runDir}/part-${part.toLowerCase()}.md", text: "${part}\\n" }
      - run: 'metator run result --run "$METATOR_RUN" --worker "$METATOR_WORKER" --status done --summary "part ${part} tested" --artifact part-${part.toLowerCase()}.md'
      - ask: { question: "Anything else?", options: [no] }`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-implementer:
    - - ask: { question: "Wait for the conductor?", options: [yes] }
  mt-orchestrator:
    - - say: "conducting in {cwd}"
      - run: 'metator run delegate build --run "$METATOR_RUN" --agent mt-tester --card "Test part A; write part-a.md"'
      - run: 'metator run delegate build --run "$METATOR_RUN" --agent mt-tester --card "Test part B; write part-b.md"'
      - run: 'metator run wait mt-tester-1 --run "$METATOR_RUN" --timeout 60000'
      - run: 'metator run wait mt-tester-2 --run "$METATOR_RUN" --timeout 60000'
      - run: 'metator run collect mt-tester-1 --run "$METATOR_RUN"'
      - run: 'metator run collect mt-tester-2 --run "$METATOR_RUN"'
      - say: "team collected"
      - ask: { question: "Advance?", options: [yes] }
  mt-tester:
${tester("A")}
${tester("B")}
`;

let folder: string;
let bin: string;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let env: Record<string, string>;
type Data = Record<string, unknown>;
interface Pane {
  id: string;
  role: string;
  runId?: string;
  cwd: string;
  worker?: { name: string; stage: string };
  ended?: { reason: string; summary?: string };
  live?: { alive: boolean; pid: number };
}
const at = (name: string) => join(folder, name);
const mt = (repo: string, ...args: string[]) => metator(args, at(repo), env);
const git = (dir: string, ...a: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...a], {
    cwd: dir,
  });
const api = async (path: string, init?: RequestInit) =>
  (await (await fetch(`${base}${path}`, init)).json()) as { ok: boolean; data: Data; error?: Data };
const panesOf = async (repo: string) => ((await api(`/layout?repo=${repo}`)).data as { panes: Pane[] }).panes;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(150);
  }
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "metator-system-sessions-"));
  // `metator` in the panes' PATH, as an installed one would be.
  bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  await chmod(join(bin, "metator"), 0o755);
  await Bun.write(join(folder, "scenario.yml"), SCENARIO);
  const repo = async (name: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) await Bun.write(join(at(name), p), t);
    git(at(name), "init", "-q", "-b", "main");
    git(at(name), "add", "-A");
    git(at(name), "commit", "-q", "-m", "init");
  };
  const W13 = await Bun.file(
    join(import.meta.dir, "..", ".github/metator/workflows/mt-system-change.yml"),
  ).text();
  const roots = APPS.map((a) => `${a}: ../${a}`).join(", ");
  await repo("platform", {
    "docs/metator/system.yml": MAP,
    "metator.config.yml": `kind: MetatorConfig\nschemaVersion: 12\nsupervisor:\n  hostOrder: [scenario]\nsystem:\n  roots: { ${roots} }\n`,
    ".github/metator/workflows/mt-system-change.yml": W13,
    ".gitignore": ".metator/\nmetator/system/\n",
  });
  for (const app of APPS)
    await repo(app, {
      "src/badge.ts": `export const ${app} = 1;\n`,
      "metator.config.yml": "kind: MetatorConfig\nschemaVersion: 12\nsupervisor:\n  hostOrder: [scenario]\n",
      ".github/metator/workflows/mt-feature.yml": FEATURE,
      ".gitignore": ".metator/\n",
    });
  // Every drive and session here uses the scenario host: no real AI host is ever started.
  env = {
    METATOR_USER: "ana",
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: join(folder, "scenario.yml"),
  };
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: folder,
    env: {
      ...process.env,
      METATOR_STATE_DIR: E2E_STATE_DIR,
      ...env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    },
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
  stopProcessesUnder(folder);
  await rm(folder, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
}, 60_000);

describe("a system plan's child runs, each with its own conductor and its workers (real daemon)", () => {
  test("three child runs in three repositories: each opened gets its own conductor, which runs two workers at once and collects them", async () => {
    const parent = (
      await mt("platform", "run", "init", "--workflow", "mt-system-change", "--task", "Add a badge")
    ).json.data as { runId: string };
    await Bun.write(join(at("platform"), "metator/system/plans/add-a-badge.yml"), PLAN);
    await Bun.write(join(at("platform"), "metator/system/plans/add-a-badge.analysis.yml"), ANALYSIS);
    expect((await mt("platform", "system", "plan", "approve", "add-a-badge", "--by", "ana")).code).toBe(0);
    const started = await mt("platform", "system", "plan", "run", "add-a-badge", "--run", parent.runId);
    const children = (started.json.data as { started: { app: string; run: string }[] }).started;
    expect(children.map((c) => c.app).sort()).toEqual([...APPS].sort());
    const runOf = (app: string) => children.find((c) => c.app === app)?.run as string;

    // The person opens each child run: one conductor session per repository, in its worktree.
    const opened: Record<string, { paneId: string; pid: number }> = {};
    for (const app of APPS) {
      const r = await api(`/runs/${runOf(app)}/pty-open?repo=${app}`, {
        method: "POST",
        body: JSON.stringify({ cols: 100, rows: 30 }),
      });
      expect(r.ok).toBe(true);
      opened[app] = r.data as { paneId: string; pid: number };
    }
    expect(new Set(APPS.map((a) => opened[a]?.pid)).size).toBe(3);
    for (const app of APPS) {
      const conductors = (await panesOf(app)).filter((p) => p.role === "conductor");
      expect(conductors.map((p) => [p.runId, p.live?.alive])).toEqual([[runOf(app), true]]);
      expect(conductors[0]?.cwd).toStartWith(at(app));
      expect(conductors[0]?.cwd).not.toBe(at(app));
    }

    // Each conductor delegates two testers (they wait for each other, so both work at once),
    // waits for both and collects them.
    for (const app of APPS)
      await until(`${app}'s conductor to collect its team`, async () => {
        const screen = (await api(`/panes/${opened[app]?.paneId}?repo=${app}`)).data.text as string;
        return screen.includes("team collected") ? true : undefined;
      });
    for (const app of APPS) {
      const panes = await panesOf(app);
      const workers = panes.filter((p) => p.role === "worker");
      expect(
        workers.map((p) => [p.runId, p.worker?.name, p.worker?.stage, p.ended?.reason, p.ended?.summary]),
      ).toEqual([
        [runOf(app), "mt-tester-1", "build", "collected", "part A tested"],
        [runOf(app), "mt-tester-2", "build", "collected", "part B tested"],
      ]);
      // The conductor still works; the workers' panes stay, to read, until a person closes them.
      const conductor = panes.find((p) => p.role === "conductor");
      expect([conductor?.ended, conductor?.live?.alive]).toEqual([undefined, true]);
      for (const w of workers)
        expect(((await api(`/panes/${w.id}?repo=${app}`)).data.text as string) ?? "").toContain(
          "testing part",
        );
      const activity = (
        (await api(`/runs/${runOf(app)}/activity?repo=${app}`)).data as { entries: { text: string }[] }
      ).entries.map((e) => e.text);
      // Both were delegated before either reported: they worked at the same time.
      const second = activity.findIndex((t) => t.startsWith("delegated build to worker mt-tester-2"));
      const firstReport = activity.findIndex((t) => t.startsWith("worker mt-tester-1 reported done"));
      expect(second).toBeGreaterThanOrEqual(0);
      expect(firstReport).toBeGreaterThan(second);
      expect(activity).toContain("collected worker mt-tester-1: done, part A tested");
      expect(activity).toContain("collected worker mt-tester-2: done, part B tested");
      expect(await Bun.file(join(at(app), `.metator/runs/${runOf(app)}/part-b.md`)).text()).toBe("B\n");
    }

    for (const app of APPS)
      await mt(app, "run", "close", "--run", runOf(app), "--aborted", "--reason", "the test ends it");
    await mt("platform", "run", "close", "--run", parent.runId, "--aborted", "--reason", "the test ends it");
  }, 240_000);
});
