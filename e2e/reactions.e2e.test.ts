/**
 * Telemetry of review comments end to end (F5): the real `metator findings react` records what
 * people did with comments; `metator report` carries the reactions and `--html` writes the dashboard.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let repo: ScratchRepo;
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(
    ".github/metator/workflows/demo.yml",
    "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n",
  );
  await repo.commit("init");
  await metator(["run", "init", "--workflow", "demo", "--task", "Add the discount"], repo.root);
});
afterAll(async () => {
  await repo.dispose();
});

describe("metator findings react and report (real CLI)", () => {
  test("reactions are recorded per comment; the report sums them; the dashboard is one HTML page", async () => {
    const a = await metator(
      [
        "findings",
        "react",
        "LOGIC-001",
        "--pr",
        "42",
        "--state",
        "resolved",
        "--by",
        "maciej",
        "--lens",
        "logic",
      ],
      repo.root,
    );
    expect(a.code).toBe(0);
    expect(data(a)).toMatchObject({ finding: "LOGIC-001", pr: "42", state: "resolved", lens: "logic" });
    expect(
      (
        await metator(
          [
            "findings",
            "react",
            "TESTS-003",
            "--pr",
            "42",
            "--state",
            "dismissed",
            "--by",
            "maciej",
            "--reason",
            "intended",
          ],
          repo.root,
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await metator(
          ["findings", "react", "X-1", "--pr", "42", "--state", "maybe", "--by", "maciej"],
          repo.root,
        )
      ).code,
    ).not.toBe(0);
    expect(
      JSON.parse((await repo.read(".metator/telemetry/reactions.jsonl")).split("\n")[0] as string),
    ).toMatchObject({ kind: "ReviewReaction", schemaVersion: 1 });
    const report = data(await metator(["report"], repo.root)) as {
      totals: { runs: number };
      reactions: { total: number; dismissedShare: number };
    };
    expect(report.totals.runs).toBe(1);
    expect(report.reactions).toMatchObject({ total: 2, resolved: 1, dismissed: 1, dismissedShare: 0.5 });
    const html = await metator(["report", "--html", "report.html"], repo.root);
    expect(html.code).toBe(0);
    expect(data(html)).toMatchObject({ output: "report.html", runs: 1, reactions: 2 });
    const page = await repo.read("report.html");
    expect(page).toContain("<title>MetatorAI report</title>");
    expect(page).toContain("50%");
    expect(page).toContain("Add the discount".slice(0, 0) + "demo");
  }, 60_000);
});
