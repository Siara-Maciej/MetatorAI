import { describe, expect, test } from "bun:test";
import { issueRef } from "../src/commands/issue.ts";

const files =
  (...paths: string[]) =>
  async (p: string) =>
    paths.includes(p);

describe("issue --ref", () => {
  test("a run, a file with or without its line, and a note", async () => {
    const none = files();
    expect(await issueRef("run:20261101-x/S2", none)).toEqual({ run: "20261101-x", step: "S2" });
    expect(await issueRef("run:20261101-x", none)).toEqual({ run: "20261101-x" });
    expect(await issueRef("src/invoice.ts:10", none)).toEqual({ file: "src/invoice.ts", line: 10 });
    expect(await issueRef("README.md", none)).toEqual({ file: "README.md" });
    expect(await issueRef("see the thread with finance", none)).toEqual({
      note: "see the thread with finance",
    });
    expect(await issueRef("  ", none)).toEqual({ note: "  " });
  });

  test("text with spaces is a file only when that file exists", async () => {
    const here = files("docs/meeting notes.md");
    expect(await issueRef("docs/meeting notes.md:4", here)).toEqual({
      file: "docs/meeting notes.md",
      line: 4,
    });
    expect(await issueRef("docs/other notes.md", here)).toEqual({ note: "docs/other notes.md" });
  });
});
