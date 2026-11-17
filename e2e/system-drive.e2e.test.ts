/**
 * A system run (W13) driven end to end in a folder of two repositories, with the scenario host:
 * one Approve on the plan-approval card approves the gate and the system plan; each child run is
 * driven as it starts, on the system run's host; the system run waits for its children without
 * spending its waves and reads as working meanwhile, starts the next wave when the first is done,
 * and reaches its delivery approval. A child that escalates makes it wait (blocked by that child)
 * until a person resumes the child.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";

const MAP = `kind: SystemMap
schemaVersion: 2
system: shop
applications:
  - { id: shop-api, kind: service, source: { path: . }, owners: ["@shop/api"] }
  - { id: shop-web, kind: frontend, source: { repo: github.com/shop/shop-web }, owners: ["@shop/web"], consumes: [prices-api] }
contracts:
  - { id: prices-api, kind: openapi, owner: shop-api, spec: { path: openapi.yaml } }
policies: { deployOrder: providers-first, breaking: expand-contract }
`;
const OPENAPI = "openapi: 3.0.0\ninfo: { title: prices, version: 1.0.0 }\npaths: {}\n";
// The child runs' W1: a stage that takes a moment, then one an agent finishes; a driven child is done by itself.
const W1 = `kind: Workflow
schemaVersion: 2
id: mt-feature
stages:
  - id: setup
    owner: "script:sleep 2"
  - id: build
    owner: mt-implementer
`;
const W1_STUCK = `kind: Workflow
schemaVersion: 2
id: mt-feature
stages:
  - id: build
    gate: { script: "test -f never-there" }
`;
const plan = (id: string, task: string) => `kind: SystemPlan
schemaVersion: 1
id: ${id}
task: ${task}
status: draft
createdBy: mt-system-planner
strategies: []
steps:
  - { id: shop-api-change, app: shop-api, summary: Add the currency field, contracts: [{ id: prices-api, role: change }], dependsOn: [], status: pending }
  - { id: shop-web-show, app: shop-web, summary: Show the currency, contracts: [], dependsOn: [shop-api-change], status: pending }
`;
const analysis = (task: string) => `kind: SystemAnalysis
schemaVersion: 1
task: ${task}
map: docs/metator/system.yml
base: HEAD
contracts:
  - { id: prices-api, owner: shop-api, change: compatible, why: "a new optional field", consumers: [{ app: shop-web }] }
applications:
  - { id: shop-api, roles: [changed, provider], owners: ["@shop/api"], files: [openapi.yaml] }
  - { id: shop-web, roles: [consumer], owners: ["@shop/web"], files: [] }
`;
const scenario = (id: string, task: string) => `kind: AgentScenario
schemaVersion: 1
agents:
  mt-system-scout:
    - - write: { path: "metator/system/plans/${id}.analysis.yml", text: ${JSON.stringify(analysis(task))} }
      - write: { path: "{runDir}/system-analysis.md", text: "# Analysis\\n" }
      - say: "STATUS: done"
  mt-system-planner:
    - - write: { path: "metator/system/plans/${id}.yml", text: ${JSON.stringify(plan(id, task))} }
      - write: { path: "{runDir}/system-plan.md", text: "# Plan\\n" }
      - say: "STATUS: done"
  mt-implementer:
    - - say: "STATUS: done"
`;

let folder: string;
const at = (name: string) => join(folder, name);
const git = (dir: string, ...a: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...a], {
    cwd: dir,
  });
let env: Record<string, string>;
const mt = (repo: string, ...args: string[]) => metator(args, at(repo), env);
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "metator-w13-"));
  const W13 = await Bun.file(
    join(import.meta.dir, "..", ".github/metator/workflows/mt-system-change.yml"),
  ).text();
  const config = `kind: MetatorConfig\nschemaVersion: 12\nhosts:\n  metatorCommand: bun ${CLI_ENTRY}\nsupervisor:\n  hostOrder: [scenario]\nsystem:\n  roots: { shop-web: ../shop-web }\n`;
  const repo = async (name: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) await Bun.write(join(at(name), p), t);
    git(at(name), "init", "-q", "-b", "main");
    git(at(name), "add", "-A");
    git(at(name), "commit", "-q", "-m", "init");
  };
  await Bun.write(join(folder, "scenario.yml"), scenario("add-currency-to-prices", "Add currency to prices"));
  await repo("shop-api", {
    "docs/metator/system.yml": MAP,
    "openapi.yaml": OPENAPI,
    "metator.config.yml": config,
    ".github/metator/workflows/mt-system-change.yml": W13,
    ".github/metator/workflows/mt-feature.yml": W1,
    ".gitignore": ".metator/\nmetator/system/\n",
  });
  await repo("shop-web", {
    "src/price-tag.ts": "export const tag = 1;\n",
    "metator.config.yml": "kind: MetatorConfig\nschemaVersion: 12\nsupervisor:\n  hostOrder: [scenario]\n",
    ".github/metator/workflows/mt-feature.yml": W1,
    ".gitignore": ".metator/\n",
  });
  env = {
    METATOR_USER: "ana",
    METATOR_AGENT_SCENARIO: join(folder, "scenario.yml"),
    METATOR_HOST: "scenario",
    METATOR_GATE_WAIT_MS: "300",
  };
});
afterAll(async () => {
  for (const repo of ["shop-api", "shop-web"]) {
    const runs = ((await mt(repo, "run", "list")).json.data ?? []) as { runId: string }[];
    for (const r of runs) await mt(repo, "run", "stop", r.runId);
  }
  stopProcessesUnder(folder);
  await rm(folder, { recursive: true, force: true });
});

describe("a driven system run (W13) in a folder of two repositories", () => {
  test("one Approve on the card; the children are driven; the run waits for them, then reaches delivery", async () => {
    const parent = data(
      await mt(
        "shop-api",
        "run",
        "new",
        "--workflow",
        "mt-system-change",
        "--task",
        "Add currency to prices",
      ),
    ).runId as string;
    expect(
      (
        await mt(
          "shop-api",
          "run",
          "drive",
          "--run",
          parent,
          "--host",
          "scenario",
          "--detach",
          "--gate-wait",
          "300",
        )
      ).code,
    ).toBe(0);

    // The plan-approval waits as a card in the inbox: one Approve approves the gate and the plan.
    const card = await until("the plan-approval card", async () => {
      const inbox = data(await mt("shop-api", "inbox")) as {
        decisions: { runId: string; question: { id: string; stage: string } }[];
      };
      return inbox.decisions.find((d) => d.runId === parent && d.question.stage === "plan-approval")
        ?.question;
    });
    const approved = await mt("shop-api", "run", "answer", card.id, "--run", parent, "--choice", "Approve");
    expect(approved.code).toBe(0);
    // The drive waiting on the card carries the answer out: the gate and the plan, by ana.
    const by = await until("the system plan's approval", async () => {
      const shown = data(await mt("shop-api", "system", "plan", "show", "add-currency-to-prices")) as {
        plan?: { approval?: { by: string } };
        approval?: { by: string };
      };
      return (shown.plan ?? shown).approval?.by;
    });
    expect(by).toBe("ana");

    // While the first child works, the system run waits and says on what; it does not escalate.
    const waiting = await until("the system run to say what it waits on", async () => {
      const a = data(await mt("shop-api", "run", "activity", parent)) as {
        entries: { type: string; text: string }[];
      };
      return a.entries.find((e) => e.type === "gate" && e.text.startsWith("waiting on children:"))?.text;
    });
    expect(waiting).toContain("shop-");

    // Both children are driven by themselves (nobody opened a session), the second after the first.
    const children = await until(
      "both children done",
      async () => {
        const api = (
          data(await mt("shop-api", "run", "list")) as unknown as {
            runId: string;
            workflow: string;
            status: string;
          }[]
        ).filter((r) => r.workflow === "mt-feature");
        const web = data(await mt("shop-web", "run", "list")) as unknown as {
          runId: string;
          status: string;
        }[];
        return api[0]?.status === "done" && web[0]?.status === "done" ? [api[0], web[0]] : undefined;
      },
      90_000,
    );
    expect(children).toHaveLength(2);

    const delivery = await until(
      "the system run at delivery",
      async () => {
        const s = data(await mt("shop-api", "run", "status", parent)) as { stage: string; status: string };
        if (s.status === "escalated") throw new Error(`the system run escalated: ${JSON.stringify(s)}`);
        return s.stage === "delivery" ? s : undefined;
      },
      90_000,
    );
    expect(delivery.status).toBe("active");
    const record = JSON.parse(
      await Bun.file(join(at("shop-api"), ".metator/runs", parent, "state.json")).text(),
    );
    // One wave per wave of the plan, not one per look: the second wave is the only loop spent.
    expect(record.state.context.loops.waves ?? 0).toBeLessThanOrEqual(1);
    expect(record.children).toHaveLength(2);
  }, 180_000);

  test("a child that escalates makes the system run wait, blocked by it; resumed, the system run goes on by itself", async () => {
    await Bun.write(join(at("shop-web"), ".github/metator/workflows/mt-feature.yml"), W1_STUCK);
    await Bun.write(join(folder, "scenario.yml"), scenario("show-prices-in-eur", "Show prices in EUR"));
    const parent = data(
      await mt("shop-api", "run", "new", "--workflow", "mt-system-change", "--task", "Show prices in EUR"),
    ).runId as string;
    await mt(
      "shop-api",
      "run",
      "drive",
      "--run",
      parent,
      "--host",
      "scenario",
      "--detach",
      "--gate-wait",
      "300",
    );
    const card = await until("the plan-approval card", async () => {
      const inbox = data(await mt("shop-api", "inbox")) as {
        decisions: { runId: string; question: { id: string; stage: string } }[];
      };
      return inbox.decisions.find((d) => d.runId === parent && d.question.stage === "plan-approval")
        ?.question;
    });
    await mt("shop-api", "run", "answer", card.id, "--run", parent, "--choice", "Approve");
    // The child in shop-web escalates: the system run does not; it waits, blocked by that child.
    const child = await until(
      "the child in shop-web to escalate",
      async () => {
        const runs =
          (data(await mt("shop-web", "run", "list")) as unknown as { runId: string; status: string }[]) ?? [];
        return runs.find((r) => r.status === "escalated" && r.runId.includes("show-price"))?.runId;
      },
      120_000,
    );
    const blockedBy = await until("the system run to say which child blocks it", async () => {
      const activity = data(await mt("shop-api", "run", "activity", "--run", parent)) as {
        entries: { type: string; text: string }[];
      };
      return activity.entries.find((e) => e.type === "gate" && e.text.startsWith("blocked by"))?.text;
    });
    expect(blockedBy).toBe(`blocked by ${child} (shop-web, at build): needs you`);
    // The child names the host that drove it (the system run's).
    expect((data(await mt("shop-web", "run", "status", child)) as { host?: string }).host).toBe("scenario");
    expect((data(await mt("shop-api", "run", "status", parent)) as { status: string }).status).toBe("active");
    // The person fixes the cause and resumes the child: the system run goes on by itself.
    await Bun.write(join(at("shop-web"), "never-there"), "now it is\n");
    expect((await mt("shop-web", "run", "resume", "--run", child, "--by", "ana", "--drive")).code).toBe(0);
    await until(
      "the system run's delivery approval",
      async () => {
        const s = data(await mt("shop-api", "run", "status", parent)) as { status: string; stage: string };
        if (s.status === "escalated") throw new Error("the system run escalated");
        return s.stage === "delivery" ? true : undefined;
      },
      120_000,
    );
    const record = JSON.parse(
      await Bun.file(join(at("shop-api"), ".metator/runs", parent, "state.json")).text(),
    );
    expect(record.state.context.loops.waves ?? 0).toBeLessThanOrEqual(1);
  }, 180_000);

  test("a plan changed after its lint passed: the card's Approve is disabled with the reason, and an Approve is refused", async () => {
    await Bun.write(join(at("shop-web"), ".github/metator/workflows/mt-feature.yml"), W1);
    await Bun.write(join(folder, "scenario.yml"), scenario("show-the-tax", "Show the tax"));
    const parent = data(
      await mt("shop-api", "run", "new", "--workflow", "mt-system-change", "--task", "Show the tax"),
    ).runId as string;
    await mt(
      "shop-api",
      "run",
      "drive",
      "--run",
      parent,
      "--host",
      "scenario",
      "--detach",
      "--gate-wait",
      "300",
    );
    const card = await until("the plan-approval card", async () => {
      const inbox = data(await mt("shop-api", "inbox")) as {
        decisions: { runId: string; question: { id: string; stage: string } }[];
      };
      return inbox.decisions.find((d) => d.runId === parent && d.question.stage === "plan-approval")
        ?.question;
    });
    // Someone edits the plan after the gate passed: a step names an application the map does not have.
    const file = join(at("shop-api"), "metator/system/plans/show-the-tax.yml");
    await Bun.write(file, (await Bun.file(file).text()).replace("app: shop-web", "app: shop-mobile"));
    const daemon = Bun.spawn(
      ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"],
      {
        cwd: at("shop-api"),
        env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const reader = daemon.stderr.getReader();
      let text = "";
      const base = await until("the daemon to listen", async () => {
        const { value, done } = await reader.read();
        if (done) return "";
        text += new TextDecoder().decode(value);
        const line = text.split("\n").find((l) => l.includes('"serving"'));
        return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
      });
      const inbox = (await (await fetch(`${base}/inbox`)).json()) as {
        data: {
          decisions: {
            runId: string;
            question: { options: { label: string; disabled?: boolean; disabledBecause?: string }[] };
          }[];
        };
      };
      const approve = inbox.data.decisions
        .find((d) => d.runId === parent)
        ?.question.options.find((o) => o.label === "Approve");
      expect(approve?.disabled).toBe(true);
      expect(approve?.disabledBecause).toStartWith("the system plan show-the-tax has ");
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
    const refused = await mt("shop-api", "run", "answer", card.id, "--run", parent, "--choice", "Approve");
    expect([refused.code, (refused.json.error as { code: string }).code]).toEqual([1, "CHECK_FAILED"]);
    const s = data(await mt("shop-api", "run", "status", parent)) as { stage: string; status: string };
    expect([s.stage, s.status]).toEqual(["plan-approval", "active"]);
    await mt("shop-api", "run", "stop", parent);
  }, 180_000);
});
