import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { ScanIntake } from "../src/application/intake.ts";
import { Issues } from "../src/application/issues.ts";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { MetatorConfigDocument } from "../src/domain/config.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { InProcessLock } from "../src/domain/in-process-lock.ts";
import { IntakeConfigSchema, type IntakeItem, sourceKey } from "../src/domain/intake.ts";
import { IssueDocument } from "../src/domain/issue.ts";
import { err, ok } from "../src/domain/result.ts";

const item = (n: number, extra: Partial<IntakeItem> = {}): IntakeItem => ({
  ref: String(n),
  title: `Bug ${n}`,
  body: `Steps for ${n}`,
  url: `https://example.com/issues/${n}`,
  labels: ["bug"],
  ...extra,
});

function world(config: unknown, items: Record<string, IntakeItem[] | MetatorError>) {
  const fs = new InMemoryFileSystem();
  const started: { workflow: string; task: string; autonomy?: string; worktree: boolean }[] = [];
  /** Per started run: what its worktree was allowed (undefined for a run in the checkout). */
  const dirty: (boolean | undefined)[] = [];
  let n = 0;
  const issues = new Issues({
    fs,
    paths: DEFAULT_PATHS,
    clock: new FixedClock(new Date("2026-11-10T12:00:00.000Z")),
    journal: { ask: async () => ok({ id: "q001" } as never), questions: async () => ok([]) },
    repo: {
      resolveId: async (id) => ok(id ?? "latest"),
      load: async () => err(MetatorError.notFound("run")),
    },
    initRun: {
      execute: async (input) => {
        started.push({
          workflow: input.workflow,
          task: input.task,
          ...(input.autonomy ? { autonomy: input.autonomy } : {}),
          worktree: input.worktree !== undefined,
        });
        dirty.push(input.worktree ? input.worktree.allowDirty === true : undefined);
        n++;
        return ok({ runId: `run-${n}` } as never);
      },
    },
  });
  const listed: string[] = [];
  const lock = new InProcessLock();
  const scan = new ScanIntake({
    config: IntakeConfigSchema.parse(config),
    issues,
    codeHost: {
      listItems: async (source) => {
        listed.push(source.kind);
        const found = items[source.kind];
        return found instanceof MetatorError ? err(found) : ok(found ?? []);
      },
    },
    activeRuns: async () => ok(started.length),
    exclusive: (work) => lock.hold("intake", work),
  });
  return { fs, issues, scan, started, listed, dirty };
}

const RULES = {
  maxActive: 2,
  rules: [
    { id: "gh-bugs", source: { kind: "github", repo: "acme/shop", labels: ["bug"] }, workflow: "mt-bugfix" },
    {
      id: "jira",
      source: { kind: "jira", project: "SHOP" },
      workflow: "mt-feature",
      autonomy: "full",
      worktree: false,
    },
  ],
};

describe("intake (T2, design/14 §3)", () => {
  test("the rules live in MetatorConfig v10 with defaults; a v9 file upgrades with none", () => {
    const v9 = MetatorConfigDocument.parse({ kind: "MetatorConfig", schemaVersion: 9 }, "x")._unsafeUnwrap();
    expect(v9.intake).toEqual({ everyMs: 120_000, maxActive: 2, rules: [] });
    const v10 = MetatorConfigDocument.parse(
      { kind: "MetatorConfig", schemaVersion: 10, intake: RULES },
      "x",
    )._unsafeUnwrap();
    expect(v10.intake.rules[0]).toEqual({
      id: "gh-bugs",
      source: { kind: "github", repo: "acme/shop", labels: ["bug"], state: "open" },
      workflow: "mt-bugfix",
      autonomy: "gated",
      worktree: true,
    });
    // Two rules with one id would make the source key ambiguous.
    expect(IntakeConfigSchema.safeParse({ rules: [RULES.rules[0], RULES.rules[0]] }).success).toBe(false);
    expect(sourceKey({ kind: "github", repo: "acme/shop", labels: [], state: "open" }, "12")).toBe(
      "github:acme/shop#12",
    );
    expect(sourceKey({ kind: "jira", project: "SHOP", labels: [], state: "open" }, "SHOP-7")).toBe(
      "jira:SHOP-7",
    );
  });

  test("a new item becomes an issue with its source and a run under the rule; a second scan starts nothing", async () => {
    const w = world(RULES, { github: [item(12)], jira: [item(7, { ref: "SHOP-7", title: "Export" })] });
    const first = (await w.scan.execute())._unsafeUnwrap();
    expect(first.rules.map((r) => [r.rule, r.listed, r.started.length, r.known])).toEqual([
      ["gh-bugs", 1, 1, 0],
      ["jira", 1, 1, 0],
    ]);
    expect(w.started).toEqual([
      {
        workflow: "mt-bugfix",
        task: expect.stringContaining("Bug 12"),
        worktree: true,
      },
      { workflow: "mt-feature", task: expect.stringContaining("Export"), autonomy: "L1", worktree: false },
    ]);
    const stored = (await w.issues.list())._unsafeUnwrap();
    expect(stored.map((i) => [i.id, i.status, i.source?.key, i.source?.rule, i.decidedBy?.by])).toEqual([
      ["i001", "in-progress", "github:acme/shop#12", "gh-bugs", "intake:gh-bugs"],
      ["i002", "in-progress", "jira:SHOP-7", "jira", "intake:jira"],
    ]);
    // The body is quoted as data with where it came from.
    expect(stored[0]?.body).toContain("https://example.com/issues/12");
    const again = (await w.scan.execute())._unsafeUnwrap();
    expect(again.rules.map((r) => [r.rule, r.started.length, r.known])).toEqual([
      ["gh-bugs", 0, 1],
      ["jira", 0, 1],
    ]);
    expect(w.started).toHaveLength(2);
  });

  test("an intake run starts from the last commit whatever is uncommitted; a person's start says so itself", async () => {
    const w = world(RULES, { github: [item(1)], jira: [item(2)] });
    (await w.scan.execute())._unsafeUnwrap();
    // The GitHub rule works in a worktree (allowed dirty); the Jira rule works in the checkout.
    expect(w.dirty).toEqual([true, undefined]);
    // Issues.start passes on what it was given, and nothing when it was given nothing.
    const added = (await w.issues.add({ title: "By hand", by: "ola" }))._unsafeUnwrap();
    (await w.issues.start(added.id, { workflow: "mt-feature" }))._unsafeUnwrap();
    const second = (await w.issues.add({ title: "By hand, dirty", by: "ola" }))._unsafeUnwrap();
    (await w.issues.start(second.id, { workflow: "mt-feature", allowDirty: true }))._unsafeUnwrap();
    expect(w.dirty.slice(2)).toEqual([false, true]);
  });

  test("two scans at the same time make one issue and one run of an item (R6)", async () => {
    const w = world(RULES, { github: [item(12)], jira: [] });
    const [a, b] = await Promise.all([w.scan.execute(), w.scan.execute()]);
    expect(a._unsafeUnwrap().started + b._unsafeUnwrap().started).toBe(1);
    expect(w.started).toHaveLength(1);
    expect((await w.issues.list())._unsafeUnwrap().map((i) => i.source?.key)).toEqual([
      "github:acme/shop#12",
    ]);
  });

  test("maxActive holds the rest back as open issues; a dry run writes nothing; a failing source is reported, not fatal", async () => {
    const w = world(
      { ...RULES, maxActive: 1 },
      { github: [item(1), item(2)], jira: MetatorError.usage("no MCP") },
    );
    const dry = (await w.scan.execute({ dryRun: true }))._unsafeUnwrap();
    expect(dry.rules[0]).toMatchObject({ listed: 2, started: [], waiting: [] });
    expect(dry.rules[0]?.new).toEqual(["github:acme/shop#1", "github:acme/shop#2"]);
    expect((await w.issues.list())._unsafeUnwrap()).toEqual([]);
    const r = (await w.scan.execute())._unsafeUnwrap();
    expect(r.rules[0]).toMatchObject({ rule: "gh-bugs", listed: 2 });
    expect(r.rules[0]?.started).toHaveLength(1);
    expect(r.rules[0]?.waiting).toEqual(["i002"]);
    expect(r.rules[1]).toMatchObject({ rule: "jira", error: "no MCP", listed: 0 });
    const stored = (await w.issues.list())._unsafeUnwrap();
    expect(stored.map((i) => i.status).sort()).toEqual(["in-progress", "open"]);
    // The waiting issue starts on a later scan, once a slot is free: it is known, not new.
    const fs2 = w.fs;
    expect(
      IssueDocument.parse(
        JSON.parse((await fs2.read(".metator/issues/i002.json"))._unsafeUnwrap()),
        "x",
      ).isOk(),
    ).toBe(true);
  });
});
