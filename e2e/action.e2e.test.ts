/**
 * The GitHub Action (`action.yml`, P8) end to end: its steps are read from the file and run as
 * GitHub would run them (bash, the expressions filled in) against the real `metator` on a real
 * repository. Every `metator` command a step names exists; the checks pass on a clean change and
 * the generated-files step fails on a stale one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly shell?: string;
  readonly if?: string;
  readonly "working-directory"?: string;
}
interface Action {
  readonly name: string;
  readonly inputs: Record<string, { readonly default?: string; readonly description: string }>;
  readonly outputs: Record<string, { readonly value: string }>;
  readonly runs: { readonly using: string; readonly steps: readonly Step[] };
}

let action: Action;
let repo: ScratchRepo;
let scratch: string;

/** A step's script with GitHub's expressions filled in as a pull request would fill them. */
function fill(script: string, inputs: Record<string, string>): string {
  const context: Record<string, string> = {
    "github.action_path": ROOT,
    "github.workspace": repo.root,
    "github.base_ref": "",
    "steps.base.outputs.ref": "HEAD~1",
  };
  return script.replace(/\$\{\{ ([a-z_.-]+) \}\}/g, (whole, name: string) => {
    if (name.startsWith("inputs.")) return inputs[name.slice("inputs.".length)] ?? "";
    return context[name] ?? whole;
  });
}

async function runStep(step: Step, inputs: Record<string, string>, cwd = repo.root) {
  const script = fill(step.run as string, inputs);
  const outputs = join(scratch, `${step.id ?? step.name}.out`);
  await writeFile(outputs, "");
  const proc = Bun.spawn(["bash", "-eo", "pipefail", "-c", script], {
    cwd,
    env: { ...process.env, METATOR_HOME: ROOT, GITHUB_OUTPUT: outputs, GITHUB_ENV: join(scratch, "env") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr, outputs: await Bun.file(outputs).text() };
}

beforeAll(async () => {
  action = parse(await Bun.file(join(ROOT, "action.yml")).text()) as Action;
  scratch = await mkdtemp(join(tmpdir(), "metator-action-"));
  repo = await ScratchRepo.create();
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.commit("base");
  await repo.write("src/b.ts", "export const b = 2;\n");
  await repo.commit("the change");
});
afterAll(async () => {
  await repo.dispose();
  await rm(scratch, { recursive: true, force: true });
});

const defaults = () =>
  Object.fromEntries(Object.entries(action.inputs).map(([k, v]) => [k, v.default ?? ""]));
const scripted = () =>
  action.runs.steps.filter((s): s is Step & { run: string } => typeof s.run === "string");

describe("the MetatorAI GitHub Action (action.yml)", () => {
  test("is a composite action whose every metator command exists, with bash steps and the documented inputs", async () => {
    expect(action.runs.using).toBe("composite");
    expect(Object.keys(action.inputs)).toEqual(["base", "gate", "sarif", "metator-ref", "working-directory"]);
    expect(Object.keys(action.outputs)).toEqual(["violations", "arch-added"]);
    const help = (await metator(["help"], repo.root)).json.data as { commands: { name: string }[] };
    const known = help.commands.map((c) => c.name);
    for (const step of scripted()) {
      expect(step.shell).toBe("bash");
      for (const m of step.run.matchAll(/main\.ts" ([a-z-]+(?: [a-z-]+)?)/g)) {
        const command = m[1] as string;
        expect([
          step.name,
          known.some((k) => k === command || k.startsWith(`${command} `) || command.startsWith(`${k} `)),
        ]).toEqual([step.name, true]);
      }
    }
    // The gate step is opt-in, the upload needs its input and a file.
    expect(action.runs.steps.find((s) => s.name === "Quality gate")?.if).toBe("inputs.gate != ''");
    expect(
      action.runs.steps.find((s) => s.uses?.startsWith("github/codeql-action/upload-sarif"))?.if,
    ).toContain("inputs.sarif == 'true'");
  });

  test("the steps pass on a clean change: the base is found, rules and architecture report zero, the specs and host files are fine", async () => {
    const inputs = { ...defaults(), "working-directory": repo.root };
    const byName = Object.fromEntries(scripted().map((s) => [s.name, s]));
    const base = await runStep(byName["The base ref"] as Step, inputs);
    expect([base.code, base.outputs.trim()]).toEqual([0, "ref=HEAD~1"]);
    const rules = await runStep(byName["Canon rules on the changed files"] as Step, inputs);
    expect([rules.code, rules.outputs.trim(), rules.stdout.includes('"violations":[]')]).toEqual([
      0,
      "violations=0",
      true,
    ]);
    const arch = await runStep(byName["Package architecture (new violations only)"] as Step, inputs);
    expect([arch.code, arch.outputs.trim()]).toEqual([0, "added=0"]);
    const specs = await runStep(byName["Workflow specs and generated host files"] as Step, inputs);
    expect([specs.code, specs.stdout.includes('"problems":[]'), specs.stdout.includes('"stale":[]')]).toEqual(
      [0, true, true],
    );
  }, 60_000);

  test("a stale generated host file fails the specs step, like a rule violation fails the rules step", async () => {
    const inputs = { ...defaults(), "working-directory": repo.root };
    const byName = Object.fromEntries(scripted().map((s) => [s.name, s]));
    await metator(["setup", "--host", "copilot", "--yes"], repo.root);
    await repo.write(".github/agents/mt-planner.agent.md", "# edited by hand\n");
    const specs = await runStep(byName["Workflow specs and generated host files"] as Step, inputs);
    expect(specs.code).toBe(1);
    expect(specs.stdout).toContain('"stale":[".github/agents/mt-planner.agent.md"]');
  }, 120_000);

  test("the Copilot coding agent's setup steps: the job GitHub looks for, every metator command real", async () => {
    const wf = parse(await Bun.file(join(ROOT, ".github/workflows/copilot-setup-steps.yml")).text()) as {
      jobs: Record<string, { steps: { run?: string }[] }>;
    };
    expect(Object.keys(wf.jobs)).toEqual(["copilot-setup-steps"]);
    const help = (await metator(["help"], repo.root)).json.data as { commands: { name: string }[] };
    const runs = (wf.jobs["copilot-setup-steps"] as { steps: { run?: string }[] }).steps
      .map((st) => st.run)
      .filter((r): r is string => typeof r === "string");
    expect(runs[0]).toBe("bun install --frozen-lockfile");
    for (const r of runs.slice(1)) {
      const command = r.replace(/^bun packages\/cli\/src\/main\.ts /, "");
      expect([command, help.commands.some((c) => c.name === command)]).toEqual([command, true]);
    }
  });

  test("the desktop workflow builds installers for Windows, macOS (one universal build) and Linux, as artifacts and on a tag as a release", async () => {
    const wf = parse(await Bun.file(join(ROOT, ".github/workflows/desktop.yml")).text()) as {
      on: { push: { tags: string[]; paths: string[] } };
      jobs: {
        build: {
          strategy: { matrix: { include: { os: string; name: string }[] } };
          steps: { uses?: string; with?: Record<string, unknown> }[];
        };
      };
    };
    expect(wf.on.push.tags).toEqual(["desktop-v*"]);
    expect(wf.jobs.build.strategy.matrix.include.map((m) => m.name)).toEqual([
      "windows-x64",
      "macos-universal",
      "linux-x64",
    ]);
    const tauri = wf.jobs.build.steps.find((s) => s.uses?.startsWith("tauri-apps/tauri-action"));
    expect(tauri?.with?.projectPath).toBe("packages/desktop");
    const upload = wf.jobs.build.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(String(upload?.with?.path)).toContain("bundle/nsis/*.exe");
    expect(String(upload?.with?.path)).toContain("bundle/dmg/*.dmg");
    // Bundling is on, with the icons every platform needs in place.
    const conf = JSON.parse(
      await Bun.file(join(ROOT, "packages/desktop/src-tauri/tauri.conf.json")).text(),
    ) as {
      bundle: { active: boolean; targets: string[]; icon: string[] };
    };
    expect(conf.bundle.active).toBe(true);
    expect(conf.bundle.targets).toEqual(expect.arrayContaining(["nsis", "msi", "dmg"]));
    for (const icon of conf.bundle.icon)
      expect([icon, await Bun.file(join(ROOT, "packages/desktop/src-tauri", icon)).exists()]).toEqual([
        icon,
        true,
      ]);
  });
});
