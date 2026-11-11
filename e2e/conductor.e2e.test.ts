/**
 * The conductor end to end (R2, ADR-0080): the real daemon opens a run as a conductor pane,
 * `metator run delegate` opens a worker pane with its card, the worker reports with
 * `metator run result`, `run wait` sees it and `run collect` closes the pane; a pane that is not
 * the run's conductor gets 403 from the steering routes; a worker's hook denies run control.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_ENTRY, E2E_STATE_DIR, hook, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
limits: { parallel: 1 }
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.md]
  - id: build
    owner: mt-implementer
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-orchestrator:
    - - say: "conducting"
      - ask: { question: "Go on?", options: [yes, no] }
  mt-planner:
    - - say: "planning as told"
      - write: { path: "{runDir}/plan.md", text: "# Plan\\n" }
      - ask: { question: "Anything else?", options: [no] }
`;

let repo: ScratchRepo;
let env: Record<string, string>;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
let runId = "";
type Data = Record<string, unknown>;
const mt = (...args: string[]) => metator(args, repo.root, env);
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const error = (r: { json: Record<string, unknown> }) => r.json.error as Data;
const get = async (path: string) =>
  (await fetch(`${base}${path}`)).json() as Promise<{ ok: boolean; data: Data }>;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("scenario.yml", SCENARIO);
  await repo.commit("init");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml") };
  runId = data(await mt("run", "init", "--workflow", "demo", "--task", "Add the discount")).runId as string;
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
  await repo.dispose();
});

describe("conductor (real daemon, real PTYs)", () => {
  test("run start opens the conductor pane; without a daemon the command says so", async () => {
    const started = data(await mt("run", "start")) as { id: string; role: string; process: Data };
    expect([started.id, started.role, started.process.agent]).toEqual([
      "w1:p1",
      "conductor",
      "mt-orchestrator",
    ]);
    await until("the conductor's first line", async () =>
      ((await get("/panes/w1:p1")).data.text as string).includes("conducting") ? true : undefined,
    );
    // Started again: the same live pane, not a second conductor.
    expect((data(await mt("run", "start")) as { id: string }).id).toBe("w1:p1");
    const elsewhere = await ScratchRepo.create();
    await elsewhere.write(".github/metator/workflows/demo.yml", WORKFLOW);
    await metator(["run", "init", "--workflow", "demo", "--task", "Elsewhere"], elsewhere.root);
    expect(error(await metator(["run", "workers"], elsewhere.root)).message).toBe(
      "no daemon runs for this repository",
    );
    await elsewhere.dispose();
  }, 30_000);

  test("delegate, result, wait, collect: a worker pane with its card, its report as the stage's artifact", async () => {
    const wrong = await mt("run", "delegate", "plan", "--agent", "mt-implementer", "--card", "x");
    expect(error(wrong).message).toBe("stage plan does not list mt-implementer");
    const d = data(
      await mt(
        "run",
        "delegate",
        "plan",
        "--agent",
        "mt-planner",
        "--card",
        "Plan the discount; write plan.md",
      ),
    ) as {
      worker: string;
      paneId: string;
      stage: string;
    };
    expect(d).toEqual({ worker: "mt-planner-1", paneId: "w1:p2", stage: "plan" });
    expect(await Bun.file(repo.path(`.metator/runs/${runId}/work/mt-planner-1.md`)).text()).toBe(
      "Plan the discount; write plan.md\n",
    );
    await until("the worker's first line", async () =>
      ((await get("/panes/w1:p2")).data.text as string).includes("planning as told") ? true : undefined,
    );
    const second = await mt("run", "delegate", "plan", "--agent", "mt-planner", "--card", "y");
    expect(error(second).message).toBe("stage plan allows 1 worker(s) at a time; mt-planner-1 still work");
    const workers = data(await mt("run", "workers")) as { workers: Data[] };
    expect(workers.workers.map((w) => [w.name, w.stage, w.paneId, w.alive])).toEqual([
      ["mt-planner-1", "plan", "w1:p2", true],
    ]);
    expect(error(await mt("run", "collect", "mt-planner-1")).message).toBe(
      "worker mt-planner-1 has not reported yet",
    );
    // The worker reports from its pane: a file, no daemon needed.
    const reported = data(
      await mt(
        "run",
        "result",
        "--worker",
        "mt-planner-1",
        "--status",
        "done",
        "--summary",
        "plan.md written",
        "--artifact",
        "plan.md",
      ),
    ) as { status: string; artifacts: string[] };
    expect([reported.status, reported.artifacts]).toEqual(["done", ["plan.md"]]);
    const waited = data(await mt("run", "wait", "mt-planner-1", "--timeout", "10000")) as {
      state: string;
      result: Data;
    };
    expect([waited.state, waited.result.summary]).toEqual(["result", "plan.md written"]);
    const collected = data(await mt("run", "collect", "mt-planner-1")) as {
      status: string;
      paneClosed: boolean;
    };
    expect([collected.status, collected.paneClosed]).toEqual(["done", true]);
    expect((await mt("pane", "read", "w1:p2")).json.ok).toBe(false);
    expect((data(await mt("run", "workers")) as { workers: Data[] }).workers).toEqual([]);
    // A name is never reused in a run.
    const again = data(
      await mt("run", "delegate", "plan", "--agent", "mt-planner", "--card", "Plan it again"),
    ) as { worker: string };
    expect(again.worker).toBe("mt-planner-2");
    const activity = await mt("run", "activity");
    expect(activity.json.error ?? null).toBeNull();
    const texts = (data(activity) as { entries: { text: string }[] }).entries.map((e) => e.text);
    expect(texts).toContain("delegated plan to worker mt-planner-1 in pane w1:p2");
    expect(texts).toContain("worker mt-planner-1 reported done: plan.md written");
    expect(texts).toContain("collected worker mt-planner-1: done, plan.md written");
  }, 60_000);

  test("only the run's conductor pane steers it: a shell pane's token gets 403; an unknown token too", async () => {
    const shell = await (
      await fetch(`${base}/panes`, {
        method: "POST",
        body: JSON.stringify({
          runId,
          role: "shell",
          label: "sh",
          argv: ["sh", "-c", "echo token=$METATOR_PANE_TOKEN; sleep 30"],
        }),
      })
    ).json();
    const shellId = (shell.data as { id: string }).id;
    const token = await until("the shell to print its token", async () => {
      const text = (await get(`/panes/${shellId}`)).data.text as string;
      return /token=([0-9a-f-]{36})/.exec(text)?.[1];
    });
    const steer = async (pane: string) =>
      fetch(`${base}/runs/${runId}/collect`, {
        method: "POST",
        headers: { "x-metator-pane": pane },
        body: JSON.stringify({ worker: "mt-planner-2" }),
      });
    const fromShell = await steer(token);
    expect(fromShell.status).toBe(403);
    expect(((await fromShell.json()) as { error: Data }).error.message).toBe(
      `pane ${shellId} (shell of run ${runId}) may not steer run ${runId}`,
    );
    const unknown = await steer("not-a-token");
    expect([unknown.status, ((await unknown.json()) as { error: Data }).error.message]).toEqual([
      403,
      "unknown pane token",
    ]);
    // The CLI from inside that pane carries the token the same way.
    const cli = await metator(["run", "workers"], repo.root, { ...env, METATOR_PANE_TOKEN: token });
    expect(cli.json.ok).toBe(true);
    const cliSteer = await metator(["run", "collect", "mt-planner-2"], repo.root, {
      ...env,
      METATOR_PANE_TOKEN: token,
    });
    expect(error(cliSteer).code).toBe("TRANSITION_DENIED");
  }, 30_000);

  test("a worker's hook denies run control and allows its report", async () => {
    const payload = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
    const steer = await hook(["guard", "pre-tool"], payload("metator run collect mt-planner-2"), repo.root, {
      METATOR_ROLE: "worker",
    });
    const decision = (steer.json?.hookSpecificOutput as Data | undefined) ?? {};
    expect(decision.permissionDecision).toBe("deny");
    expect(String(decision.permissionDecisionReason)).toContain("is the conductor's");
    const report = await hook(
      ["guard", "pre-tool"],
      payload('metator run result --worker mt-planner-2 --status done --summary "ok"'),
      repo.root,
      { METATOR_ROLE: "worker" },
    );
    expect(report.json).toBeNull();
    // The conductor's pane may delegate; its hook only stops it from editing code.
    const edit = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Edit", tool_input: { file_path: repo.path("src/a.ts") } },
      repo.root,
      { METATOR_ROLE: "conductor" },
    );
    expect((edit.json?.hookSpecificOutput as Data | undefined)?.permissionDecision).toBe("deny");
  });
});
