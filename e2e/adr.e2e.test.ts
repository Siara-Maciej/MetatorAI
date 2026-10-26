/** `metator adr lint` end to end: the real process on a real decision log. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const SELF = join(import.meta.dir, "..");
const ADR = (n: string, status: string, extra = "") =>
  `# ADR-${n}: Decision ${n}\n\n- Status: ${status}\n- Date: 2026-10-26\n\n## Context\nc\n\n## Decision\nd\n\n## Consequences\ne\n${extra}`;

let repo: ScratchRepo;
beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write("docs/adr/0001-use-postgres.md", ADR("0001", "Proposed"));
  await repo.write(
    "docs/adr/README.md",
    "| ADR | Status |\n|---|---|\n| [0001](0001-use-postgres.md) | Proposed |\n",
  );
  await repo.commit("init");
});
afterAll(async () => {
  await repo.dispose();
});

type Data = Record<string, unknown>;

describe("metator adr lint", () => {
  test("a healthy log passes", async () => {
    const r = await metator(["adr", "lint"], repo.root);
    expect([r.code, r.json.data]).toEqual([0, { adrs: 1, byStatus: { Proposed: 1 }, problems: [] }]);
  });

  test("accepting an ADR without implications for code fails, and so does a stale index", async () => {
    await repo.write("docs/adr/0001-use-postgres.md", ADR("0001", "Accepted"));
    try {
      const r = await metator(["adr", "lint"], repo.root);
      expect(r.code).toBe(1);
      const messages = ((r.json.error as { details: Data }).details.problems as Data[]).map((p) => p.message);
      expect(messages).toEqual([
        'Accepted ADRs need "## Implications for code" or "## Implikacje dla kodu" naming the rules they imply',
        "row for 0001-use-postgres.md does not show its status Accepted",
      ]);
    } finally {
      await repo.git("checkout", "--", "docs/adr/0001-use-postgres.md");
    }
  });

  test("a repository without ADRs has nothing to lint", async () => {
    const empty = await ScratchRepo.create();
    try {
      expect((await metator(["adr", "lint"], empty.root)).json.data).toEqual({
        adrs: 0,
        byStatus: {},
        problems: [],
      });
    } finally {
      await empty.dispose();
    }
  });

  test("dogfood: MetatorAI's decision log is consistent", async () => {
    const r = await metator(["adr", "lint", "--root", SELF], SELF);
    expect([r.code, (r.json.data as Data).problems]).toEqual([0, []]);
  });
});
