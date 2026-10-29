/** `worktree *` and `run init --worktree` end to end: real `metator`, real git worktrees, real ports. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const FEATURE = `kind: Workflow
schemaVersion: 1
id: feature
stages:
  - id: build
`;
const AT = (hhmm: string, day = "27") => ({ METATOR_NOW: `2026-10-${day}T${hhmm}:00.000Z` });

interface Entry {
  id: string;
  path: string;
  branch: string;
  ports: { from: number; count: number };
  run?: string;
  runStatus?: string;
  dirty: boolean;
}

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/feature.yml", FEATURE);
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator worktree (real CLI)", () => {
  test("two runs work in two worktrees with disjoint ports", async () => {
    const one = await metator(
      ["run", "init", "--workflow", "feature", "--task", "One", "--worktree"],
      repo.root,
      AT("09:00"),
    );
    const two = await metator(
      ["run", "init", "--workflow", "feature", "--task", "Two", "--worktree", "--base", "main"],
      repo.root,
      AT("09:05"),
    );
    const [a, b] = [one, two].map(
      (r) => r.json.data as { runId: string; worktree: { path: string; branch: string } },
    );
    expect([one.code, two.code]).toEqual([0, 0]);
    expect(a?.worktree.path).toBe(`.metator/wt/${a?.runId}`);
    expect(await repo.read(`${a?.worktree.path}/src/a.ts`)).toBe("export const a = 1;\n");
    // `+` marks a branch checked out in another worktree.
    const branches = (await repo.git("branch", "--list", "metator/*"))
      .split(/\s+/)
      .filter((t) => t.startsWith("metator/"));
    expect(branches).toEqual([`metator/${a?.runId}`, `metator/${b?.runId}`]);

    const list = await metator(["worktree", "list"], repo.root);
    const entries = (list.json.data as { worktrees: Entry[] }).worktrees;
    expect(entries.map((e) => [e.run, e.runStatus, e.dirty])).toEqual([
      [a?.runId, "active", false],
      [b?.runId, "active", false],
    ]);
    const [p, q] = entries.map((e) => e.ports);
    expect(p && q && (p.from + p.count <= q.from || q.from + q.count <= p.from)).toBe(true);
    // A worktree holds the person's code; everything else MetatorAI wrote is a versioned document.
    expect((await findUnversioned(repo.root, [".metator"], [".metator/wt/**"])).unversioned).toEqual([]);
  });

  test("new with an explicit id and port count; the id cannot be taken twice", async () => {
    const r = await metator(["worktree", "new", "spike", "--ports", "5"], repo.root);
    const vars = (r.json.data as { variables: Record<string, string> }).variables;
    expect([vars.METATOR_WORKTREE, vars.METATOR_PORT_COUNT]).toEqual(["spike", "5"]);
    expect([r.code, (r.json.data as Entry).ports.count, (r.json.data as Entry).branch]).toEqual([
      0,
      5,
      "metator/spike",
    ]);
    const again = await metator(["worktree", "new", "spike"], repo.root);
    expect([again.code, (again.json.error as { message: string }).message]).toEqual([
      64,
      "worktree spike already exists",
    ]);
  });

  test("rm refuses uncommitted work without --force", async () => {
    await repo.write(".metator/wt/spike/src/a.ts", "export const a = 2;\n");
    const refused = await metator(["worktree", "rm", "spike"], repo.root);
    expect([refused.code, (refused.json.error as { message: string }).message]).toEqual([
      64,
      "worktree spike has uncommitted changes",
    ]);
    const forced = await metator(["worktree", "rm", "spike", "--force"], repo.root);
    expect(forced.code).toBe(0);
    expect([
      await repo.exists(".metator/wt/spike/src/a.ts"),
      await repo.exists(".metator/wt/spike.env"),
    ]).toEqual([false, false]);
  });

  test("prune removes worktrees of finished runs past the age, never an active one", async () => {
    const list = async () =>
      ((await metator(["worktree", "list"], repo.root)).json.data as { worktrees: Entry[] }).worktrees;
    const [first, second] = (await list()) as [Entry, Entry];
    await metator(["run", "close", "--run", first.run as string, "--aborted", "--reason", "done"], repo.root);
    const early = await metator(["worktree", "prune", "--older-than", "7"], repo.root, AT("09:00", "29"));
    expect((early.json.data as { removed: string[] }).removed).toEqual([]);
    const dry = await metator(["worktree", "prune", "--dry-run"], repo.root, AT("09:00", "31"));
    expect((dry.json.data as { removed: string[] }).removed).toEqual([]); // 4 days old < 7
    const late = await metator(["worktree", "prune", "--older-than", "3"], repo.root, AT("09:00", "31"));
    expect((late.json.data as { removed: string[] }).removed).toEqual([first.id]);
    expect((await list()).map((e) => e.id)).toEqual([second.id]);
    expect(await repo.git("worktree", "list")).not.toContain(first.id);
  }, 60_000); // seven CLI processes
});
