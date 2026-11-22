/** Parent and child items (ADR-0096): made together, started in dependency order, the parent done by itself. */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PATHS,
  InitRun,
  type Issue,
  Issues,
  ok,
  RunJournal,
  RunRepository,
  WorkflowCatalog,
} from "@metator/core";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-22T10:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const initRun = new InitRun(new WorkflowCatalog(fs, DEFAULT_PATHS), repo, clock);
  const issues = new Issues({
    fs,
    paths: DEFAULT_PATHS,
    clock,
    journal: new RunJournal(fs, repo, clock),
    repo,
    initRun,
  });
  return { fs, clock, repo, issues };
}

const item = (id: string, now: string, over: Partial<Issue> = {}): Issue => ({
  id,
  title: `Item ${id}`,
  body: "",
  status: "open",
  priority: "normal",
  labels: [],
  refs: [],
  dependsOn: [],
  createdAt: now,
  updatedAt: now,
  ...over,
});

async function family(w: ReturnType<typeof world>) {
  return (
    await w.issues.create(3, (ids, now) =>
      ok([
        item(ids[0] as string, now),
        item(ids[1] as string, now, { parent: ids[0] as string }),
        item(ids[2] as string, now, { parent: ids[0] as string, dependsOn: [ids[1] as string] }),
      ]),
    )
  )._unsafeUnwrap();
}

describe("parent and child items", () => {
  test("made in one step with free ids, after the ones taken", async () => {
    const w = world();
    (await w.issues.add({ title: "First", by: "ana" }))._unsafeUnwrap();
    expect((await family(w)).map((i) => [i.id, i.parent, i.dependsOn])).toEqual([
      ["i002", undefined, []],
      ["i003", "i002", []],
      ["i004", "i002", ["i003"]],
    ]);
  });

  test("a child starts only when every item it depends on is done; the refusal names them", async () => {
    const w = world();
    await family(w);
    const refused = await w.issues.start("i003", { workflow: "demo", worktree: false });
    expect(refused._unsafeUnwrapErr().message).toBe(
      "issue i003 waits for i002 (open): start it when they are done",
    );
    expect((await w.issues.show("i003"))._unsafeUnwrap().status).toBe("open");
    (await w.issues.close("i002", { by: "ana" }))._unsafeUnwrap();
    expect((await w.issues.start("i003", { workflow: "demo", worktree: false })).isOk()).toBe(true);
  });

  test("a parent is done by itself once every child is done or dropped", async () => {
    const w = world();
    await family(w);
    (await w.issues.close("i002", { by: "ana" }))._unsafeUnwrap();
    expect((await w.issues.show("i001"))._unsafeUnwrap().status).toBe("open");
    (await w.issues.drop("i003", { by: "ana" }))._unsafeUnwrap();
    const parent = (await w.issues.show("i001"))._unsafeUnwrap();
    expect([parent.status, parent.updatedAt]).toEqual(["done", "2026-11-22T10:00:00.000Z"]);
  });

  test("update reads, changes and writes one item; an unchanged item is not written", async () => {
    const w = world();
    await family(w);
    w.clock.advance(60_000);
    const changed = (
      await w.issues.update("i002", (i) => ok({ ...i, threadId: "20261122-x" }))
    )._unsafeUnwrap();
    expect([changed.threadId, changed.updatedAt]).toEqual(["20261122-x", "2026-11-22T10:01:00.000Z"]);
    w.clock.advance(60_000);
    const same = (await w.issues.update("i002", (i) => ok(i)))._unsafeUnwrap();
    expect(same.updatedAt).toBe("2026-11-22T10:01:00.000Z");
  });

  test("a run that only plans, with its own brief", async () => {
    const w = world();
    (await w.issues.add({ title: "Round", by: "ana" }))._unsafeUnwrap();
    const plan = await w.issues.start("i001", {
      workflow: "demo",
      worktree: false,
      brief: "# Round\n\nWith the analysis.\n",
    });
    const runId = plan._unsafeUnwrap().runId;
    expect((await w.fs.read(`${w.repo.runDir(runId)}/task.md`))._unsafeUnwrap()).toBe(
      "# Round\n\nWith the analysis.\n",
    );
  });
});
