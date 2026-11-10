/** `meta quarterly` end to end: the real `metator` process on a real repository writes one review. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("metator.config.yml", "kind: MetatorConfig\nschemaVersion: 1\n");
  await repo.write("docs/README.md", "# Docs\n\nSee [missing](./missing.md).\n");
  await repo.write("docs/metator/lessons/wait-for-open.md", "# Wait for the socket to open\n");
  await repo.write(
    "docs/metator/memory-map.yml",
    `kind: MemoryMap
schemaVersion: 1
items:
  - id: t4.lessons
    tier: T4
    kind: learned
    paths: ["docs/metator/lessons/*.md"]
    load: explicit
    writers: [mt-retro]
    readers: [mt-planner]
`,
  );
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator meta quarterly (real CLI)", () => {
  test("writes a versioned QuarterlyReview with the numbers and the actions they imply", async () => {
    const r = await metator(["meta", "quarterly", "--stale-days", "1"], repo.root);
    expect(r.code).toBe(0);
    const d = data(r);
    expect(d.staleDays).toBe(1);
    expect(d.evals).toEqual({ status: "no-baseline", hint: expect.stringContaining("--baseline") });
    expect((d.docs as Data).deadLinks).toBe(1);
    expect((d.lessons as Data).total).toBe(1);
    expect(d.actions).toContain("fix 1 dead link(s)");
    expect(d.actions).toContain("commit an eval baseline so the next quarter compares against it");
    expect(r.json.warnings).toEqual(d.actions);
    const output = d.output as string;
    expect(output).toMatch(/^\.metator\/reviews\/quarterly-\d{4}-\d{2}-\d{2}\.json$/);
    const written = JSON.parse(await repo.read(output)) as Data;
    expect(written.kind).toBe("QuarterlyReview");
    expect(written.schemaVersion).toBe(1);
  });

  test("a tolerance outside (0, 1] is refused by the parser", async () => {
    const r = await metator(["meta", "quarterly", "--tolerance", "7"], repo.root);
    expect(r.code).not.toBe(0);
  });

  test("without a memory map the review stops with NOT_FOUND and the hint to write one", async () => {
    const bare = await ScratchRepo.create();
    try {
      await bare.write("metator.config.yml", "kind: MetatorConfig\nschemaVersion: 1\n");
      await bare.commit("init");
      const r = await metator(["meta", "quarterly"], bare.root);
      expect(r.code).not.toBe(0);
      expect((r.json.error as Data).code).toBe("NOT_FOUND");
    } finally {
      await bare.dispose();
    }
  });
});
