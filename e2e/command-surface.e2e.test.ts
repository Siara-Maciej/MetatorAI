/**
 * The command surface as a person and a script meet it, end to end with the real `metator`:
 * a renamed command under its new and its old words, the run named as a word or as `--run`, who
 * acts when `--by` is left out, `help --for`, and at a terminal the text a person reads beside the
 * JSON line (`--json`: the line alone), and `run continue` offering an escalated run its resume.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { inTerminal, KEY } from "./helpers/terminal.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: plan
    owner: mt-planner
    produces: [plan.md]
  - id: approval
    hitl: true
  - id: check
    gate: { script: "test -f {runDir}/fixed" }
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 1
agents:
  mt-planner:
    - - write: { path: "{runDir}/plan.md", text: "# Plan\\n" }
      - say: "STATUS: done"
`;

type Data = Record<string, unknown>;
type E = { code: string; message: string; hint?: string };
let repo: ScratchRepo;
let env: Record<string, string>;
const mt = (...args: string[]) => metator(args, repo.root, env);
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const error = (r: { json: Record<string, unknown> }) => r.json.error as E;

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
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
  await repo.git("config", "user.name", "Git Name");
  env = { METATOR_AGENT_SCENARIO: repo.path("scenario.yml"), METATOR_USER: "", USER: "login" };
});
afterAll(async () => {
  const runs = (await mt("run", "list")).json.data as { runId: string }[];
  for (const r of runs) await mt("run", "stop", "--run", r.runId);
  await repo.dispose();
});

describe("the command surface (real CLI)", () => {
  test("a renamed command runs under its new words and its old ones; the help lists the new", async () => {
    // run new / run init
    const fresh = await mt("run", "new", "--workflow", "demo", "--task", "Under the new name");
    const old = await mt("run", "init", "--workflow", "demo", "--task", "Under the old name");
    expect([fresh.code, old.code]).toEqual([0, 0]);
    expect(Object.keys(data(fresh)).sort()).toEqual(Object.keys(data(old)).sort());
    const id = data(fresh).runId as string;

    // run take / run attach: the session's keyboard, by the same use case.
    const taken = data(await mt("run", "take", "--run", id, "--by", "ola")) as {
      driver: { attachedBy: string };
    };
    expect(taken.driver.attachedBy).toBe("ola");
    await mt("run", "release", "--run", id);
    const attached = data(await mt("run", "attach", "--run", id, "--by", "ola")) as typeof taken;
    expect(attached.driver.attachedBy).toBe("ola");
    await mt("run", "release", "--run", id);

    // docs schema / docs claims-schema, meta schema <kind> / meta agents-schema, meta skills-schema
    expect((await mt("docs", "schema")).json).toEqual((await mt("docs", "claims-schema")).json);
    const agents = await mt("meta", "schema", "agents");
    const skills = await mt("meta", "schema", "skills");
    expect(agents.json).toEqual((await mt("meta", "agents-schema")).json);
    expect(skills.json).toEqual((await mt("meta", "skills-schema")).json);
    expect(agents.json).not.toEqual(skills.json);
    const neither = await mt("meta", "schema", "prompts");
    expect([neither.code, error(neither).code]).toEqual([64, "USAGE"]);

    // issue rm / issue drop
    const first = data(await mt("issue", "add", "Not worth doing")) as { id: string };
    const second = data(await mt("issue", "add", "Neither is this")) as { id: string };
    const removed = data(await mt("issue", "rm", first.id)) as { status: string; decidedBy?: string };
    const dropped = data(await mt("issue", "drop", second.id)) as { status: string };
    expect([removed.status, dropped.status]).toEqual(["dropped", "dropped"]);

    // system plan status / system status: the same answer (here: there is no plan to read)
    const now = await mt("system", "plan", "status");
    const before = await mt("system", "status");
    expect([now.code, now.json]).toEqual([before.code, before.json]);

    const listed = (data(await mt("help")) as { commands: { name: string }[] }).commands.map((c) => c.name);
    for (const name of [
      "run new",
      "run take",
      "docs schema",
      "meta schema",
      "issue rm",
      "system plan status",
    ])
      expect([name, listed.includes(name)]).toEqual([name, true]);
    for (const name of [
      "run init",
      "run attach",
      "docs claims-schema",
      "meta agents-schema",
      "issue drop",
      "system status",
      "ui",
    ])
      expect([name, listed.includes(name)]).toEqual([name, false]);
    const help = data(await mt("run", "init", "--help")) as { name: string; options: { flags: string }[] };
    expect([help.name, help.options.some((o) => o.flags === "--workflow <id>")]).toEqual(["run init", true]);
  }, 120_000);

  test("the run as a word or as --run: the same answer; two different runs are a usage error", async () => {
    const a = data(await mt("run", "new", "--workflow", "demo", "--task", "First")).runId as string;
    const b = data(await mt("run", "new", "--workflow", "demo", "--task", "Second")).runId as string;
    for (const command of [
      ["run", "status"],
      ["run", "board"],
      ["run", "activity"],
      ["run", "brief", "--peek"],
    ]) {
      const word = await mt(...command, a);
      const flag = await mt(...command, "--run", a);
      expect([command.join(" "), word.code, (data(word) as { runId: string }).runId]).toEqual([
        command.join(" "),
        0,
        a,
      ]);
      expect([command.join(" "), (data(flag) as { runId: string }).runId]).toEqual([command.join(" "), a]);
    }
    expect((data(await mt("run", "status")) as { runId: string }).runId).toBe(b); // the latest, as before
    const two = await mt("run", "status", a, "--run", b);
    expect([two.code, error(two).message]).toEqual([64, `two runs named: ${a} and --run ${b}`]);
    const stopped = await mt("run", "stop", a);
    expect((data(stopped) as { runId: string }).runId).toBe(a);
    const closed = await mt("run", "close", a, "--aborted", "--reason", "not needed");
    expect([closed.code, (data(closed) as { runId: string }).runId]).toEqual([0, a]);
  }, 120_000);

  test("who acts without --by: $METATOR_USER, else git's user.name, else the login name; an approval names its author", async () => {
    const id = data(await mt("run", "new", "--workflow", "demo", "--task", "Who")).runId as string;
    const by = async (extra: Record<string, string>) => {
      const r = await metator(["run", "take", "--run", id], repo.root, { ...env, ...extra });
      await mt("run", "release", "--run", id);
      return (data(r) as { driver: { attachedBy: string } }).driver.attachedBy;
    };
    expect(await by({ METATOR_USER: "env-user" })).toBe("env-user");
    expect(await by({})).toBe("Git Name");
    await repo.git("config", "--unset", "user.name");
    // No name in git at all (the machine's own config left out): the login name.
    expect(await by({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" })).toBe("login");
    const nobody = await metator(["run", "take", "--run", id], repo.root, {
      ...env,
      USER: "",
      USERNAME: "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    expect([nobody.code, error(nobody).message]).toEqual([64, "say who you are: --by <name>"]);
    await repo.git("config", "user.name", "Git Name");
    const approve = await mt("run", "approve", "approval", "--run", id);
    expect([approve.code, error(approve).code, error(approve).message]).toEqual([
      64,
      "USAGE",
      "required option '--by <name>' not specified",
    ]);
    const note = data(await mt("review", "notes", "add", "Look here", "--run", id)) as { by?: string };
    expect(JSON.stringify(note)).toContain("Git Name");
  }, 120_000);

  test("help --for: one audience's commands; --json is accepted where nothing is rendered", async () => {
    const hooks = data(await mt("help", "--for", "hook")) as {
      audience: string;
      commands: { name: string }[];
    };
    expect([hooks.audience, hooks.commands.map((c) => c.name)]).toEqual([
      "hook",
      [
        "guard pre-tool",
        "guard post-edit",
        "guard stop",
        "guard subagent-output",
        "guard session-start",
        "guard precompact",
      ],
    ]);
    const persons = (data(await mt("help", "--for", "person")) as { commands: { name: string }[] }).commands;
    expect(persons.map((c) => c.name)).toContain("inbox");
    expect(persons.map((c) => c.name)).not.toContain("run advance");
    const plain = await mt("inbox");
    const quiet = await mt("inbox", "--json");
    expect([quiet.code, quiet.stderr, quiet.stdout]).toEqual([0, "", plain.stdout]);
    expect(plain.stderr).toBe(""); // a pipe: the JSON line alone, as ever
  }, 60_000);

  test("at a terminal: status, inbox, run status and doctor are text a person reads, with the JSON line; --json is the line alone", async () => {
    const id = data(await mt("run", "new", "--workflow", "demo", "--task", "Read me at a terminal"))
      .runId as string;
    const status = await inTerminal(["status"], repo.root, [], 30_000, env);
    expect(status.code).toBe(0);
    expect(status.screen).toMatch(/\d+ need you · \d+ working · \d+ stopped/);
    expect(status.screen).toContain("Read me at a terminal");
    expect(status.screen).toContain("[plan ⟳] ─ approval · ─ check ·");
    expect((status.json.data as { runs: unknown[] }).runs.length).toBeGreaterThan(0);
    const one = await inTerminal(["run", "status", id], repo.root, [], 30_000, env);
    expect(one.screen).toContain(`${id} · demo · L0`);
    expect(one.screen).toContain("active at plan");
    expect((one.json.data as { runId: string }).runId).toBe(id);
    const inbox = await inTerminal(["inbox"], repo.root, [], 30_000, env);
    expect(inbox.screen).toContain("Nothing waits for you.");
    const doctor = await inTerminal(["doctor"], repo.root, [], 30_000, env);
    expect(doctor.screen).toMatch(/[✓!✗] workflows/);
    const help = await inTerminal(["run", "status", "--help"], repo.root, [], 30_000, env);
    expect(help.screen).toContain("metator run status [options] [run]");
    const quiet = await inTerminal(["status", "--json"], repo.root, [], 30_000, env);
    expect(quiet.screen).not.toContain("need you");
    expect((quiet.json.data as { runs: unknown[] }).runs.length).toBeGreaterThan(0);
  }, 120_000);

  test("run continue on an escalated run: refused with the way out without a terminal; at one, a yes resumes and drives it", async () => {
    const id = data(await mt("run", "new", "--workflow", "demo", "--task", "Escalates at its gate"))
      .runId as string;
    await mt("run", "drive", "--run", id, "--host", "scenario", "--detach");
    const gate = await until("the approval question", async () => {
      const qs = (
        data(await mt("run", "questions", "--run", id)) as { questions: { id: string; stage: string }[] }
      ).questions;
      return qs.find((q) => q.stage === "approval");
    });
    await mt("run", "answer", gate.id, "--run", id, "--choice", "Approve", "--by", "ola");
    const statusIs = (wanted: string) =>
      until(`run ${id} to be ${wanted}`, async () => {
        const s = data(await mt("run", "status", id));
        return s.status === wanted ? s : undefined;
      });
    await statusIs("escalated");
    // Without a terminal nothing is resumed unasked: the refusal names the resume, as before.
    const refused = await mt("run", "continue", id);
    expect(refused.code).toBe(64);
    expect(error(refused).message).toStartWith(`run ${id} escalated at check`);
    expect((await statusIs("escalated")).status).toBe("escalated");
    // At a terminal: a no leaves it escalated.
    const left = await inTerminal(
      ["run", "continue", id],
      repo.root,
      [{ waitFor: "Is its cause fixed", keys: `${KEY.down}${KEY.enter}` }],
      30_000,
      env,
    );
    expect([left.code, (left.json.error as E).message]).toEqual([64, "nothing continued"]);
    expect((await statusIs("escalated")).status).toBe("escalated");
    // The cause fixed and a yes: resumed under the person's name and driven to the end.
    await repo.write(`.metator/runs/${id}/fixed`, "");
    const resumed = await inTerminal(
      ["run", "continue", id, "--host", "scenario"],
      repo.root,
      [{ waitFor: "Is its cause fixed", keys: KEY.enter }],
      60_000,
      env,
    );
    expect(resumed.code).toBe(0);
    await statusIs("done");
    expect(await repo.read(`.metator/runs/${id}/log.md`)).toContain("Git Name");
  }, 180_000);
});
