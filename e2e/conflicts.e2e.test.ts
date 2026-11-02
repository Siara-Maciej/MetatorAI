/**
 * Conflicts between sessions end to end (P7, D5): two runs in real worktrees that change the
 * same file are found by `metator worktree conflicts`, with the merge order; `--notify` sends
 * both a message; the daemon's `/conflicts` says the same.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

let repo: ScratchRepo;
const mt = (...args: string[]) => metator(args, repo.root);
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write("src/invoice.ts", "export const invoice = 1;\n");
  await repo.write("src/web.ts", "export const web = 1;\n");
  await repo.commit("init");
});
afterAll(async () => repo.dispose());

describe("worktree conflicts (real CLI)", () => {
  test("two worktree runs on one file: the conflict, the merge order, the messages", async () => {
    const a = data(
      await mt(
        "run",
        "init",
        "--workflow",
        "demo",
        "--task",
        "Add the due date to the invoice",
        "--worktree",
        "--no-setup",
      ),
    );
    const b = data(
      await mt(
        "run",
        "init",
        "--workflow",
        "demo",
        "--task",
        "Add the invoice list to the web app",
        "--worktree",
        "--no-setup",
      ),
    );
    const wt = (r: Data) => join(repo.root, (r.worktree as { path: string }).path);
    await writeFile(join(wt(a), "src/invoice.ts"), "export const invoice = 2;\n");
    await writeFile(join(wt(b), "src/invoice.ts"), "export const invoice = 3;\n");
    await writeFile(join(wt(b), "src/web.ts"), "export const web = 2;\n");
    await writeFile(join(wt(b), "src/new.ts"), "export const fresh = 1;\n");
    const r = data(await mt("worktree", "conflicts")) as {
      changes: { runId: string; files: string[] }[];
      conflicts: { runs: string[]; files: string[]; mergeFirst: string }[];
    };
    expect(r.changes.map((c) => c.files)).toEqual([
      ["src/invoice.ts"],
      ["src/invoice.ts", "src/new.ts", "src/web.ts"],
    ]);
    expect(r.conflicts).toEqual([
      {
        runs: [a.runId as string, b.runId as string],
        files: ["src/invoice.ts"],
        mergeFirst: a.runId as string,
      },
    ]);
    const notified = data(await mt("worktree", "conflicts", "--notify", "--by", "alice")) as {
      notified: string[];
    };
    expect(notified.notified).toEqual([`m001→${a.runId}`, `m001→${b.runId}`]);
    const messages = data(await mt("run", "messages", "--run", b.runId as string)) as {
      messages: { topic: string; refs: string[] }[];
    };
    expect(messages.messages.map((m) => [m.topic, m.refs])).toEqual([["shared-file", ["src/invoice.ts"]]]);
  }, 60_000);
});
