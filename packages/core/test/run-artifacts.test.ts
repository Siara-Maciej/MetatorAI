import { describe, expect, test } from "bun:test";
import { FixedClock, InMemoryFileSystem } from "@metator/testing";
import { DEFAULT_PATHS } from "../src/application/paths.ts";
import { RunArtifacts } from "../src/application/run-artifacts.ts";
import { RunRepository } from "../src/application/run-repository.ts";
import { InitRun } from "../src/application/runs.ts";
import { WorkflowCatalog } from "../src/application/workflow-catalog.ts";
import { artifactKind, artifactNameProblem, capText } from "../src/domain/run-artifacts.ts";
import type { FileStat } from "../src/ports/index.ts";

const WORKFLOW = `kind: Workflow
schemaVersion: 2
id: demo
stages:
  - id: plan
    produces: [plan.json, plan.md]
  - id: build
    produces: [build-log.md, out.bin]
`;

async function world() {
  const fs = new InMemoryFileSystem({ ".github/metator/workflows/demo.yml": WORKFLOW });
  const clock = new FixedClock(new Date("2026-11-15T10:00:00.000Z"));
  const repo = new RunRepository(fs, DEFAULT_PATHS);
  const catalog = new WorkflowCatalog(fs, DEFAULT_PATHS);
  const run = (
    await new InitRun(catalog, repo, clock).execute({ workflow: "demo", task: "Add it" })
  )._unsafeUnwrap();
  const dir = repo.runDir(run.runId);
  await fs.write(`${dir}/plan.md`, "# Plan\n");
  await fs.write(`${dir}/results/mt-planner-1.json`, "{}");
  await fs.write(`${dir}/secret.bin`, "x");
  await fs.write(`${dir}/link.md`, "outside");
  // Links: `link.md` leads out of the run directory.
  const links = new Map([[`${dir}/link.md`, "/etc/passwd"]]);
  const stats = {
    stat: async (path: string): Promise<FileStat | undefined> => {
      if (path === dir) return { directory: true, size: 0, modifiedAt: "t0", real: `/repo/${dir}` };
      const text = await fs.read(path);
      if (text.isErr()) return undefined;
      return {
        directory: false,
        size: text.value.length,
        modifiedAt: "2026-11-15T09:00:00.000Z",
        real: links.get(path) ?? `/repo/${path}`,
      };
    },
  };
  return { fs, run, dir, artifacts: new RunArtifacts({ fs, stats, repo, catalog }) };
}

describe("the files of a run in the app", () => {
  test("lists the run directory's text files and the workflow's artifacts not written yet; no link out, no other kind", async () => {
    const w = await world();
    const list = (await w.artifacts.list(w.run.runId))._unsafeUnwrap();
    const byName = Object.fromEntries(list.map((a) => [a.name, a]));
    expect(byName["plan.md"]).toEqual({
      name: "plan.md",
      kind: "markdown",
      size: 7,
      updatedAt: "2026-11-15T09:00:00.000Z",
      expected: false,
      stage: "plan",
      bookkeeping: false,
    });
    expect(byName["results/mt-planner-1.json"]).toMatchObject({ kind: "json", expected: false });
    expect(byName["state.json"]).toMatchObject({ kind: "json", bookkeeping: true });
    expect(byName["plan.json"]).toEqual({
      name: "plan.json",
      kind: "json",
      size: 0,
      updatedAt: null,
      expected: true,
      stage: "plan",
      bookkeeping: false,
    });
    expect(byName["build-log.md"]?.expected).toBe(true);
    expect(Object.keys(byName)).not.toContain("secret.bin");
    expect(Object.keys(byName)).not.toContain("out.bin");
    expect(Object.keys(byName)).not.toContain("link.md");
  });

  test("reads a name inside the run directory; refuses a path out of it, a link out, another kind; capped", async () => {
    const w = await world();
    expect((await w.artifacts.read(w.run.runId, "plan.md"))._unsafeUnwrap()).toEqual({
      name: "plan.md",
      kind: "markdown",
      text: "# Plan\n",
      truncated: false,
    });
    for (const name of [
      "../../../etc/passwd.md",
      "/etc/passwd.md",
      "results/../../x.md",
      "secret.bin",
      "a\\b.md",
    ])
      expect((await w.artifacts.read(w.run.runId, name))._unsafeUnwrapErr().code).toBe("USAGE");
    expect((await w.artifacts.read(w.run.runId, "link.md"))._unsafeUnwrapErr().message).toContain(
      "leads out of the run directory",
    );
    expect((await w.artifacts.read(w.run.runId, "nope.md"))._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    await w.fs.write(`${w.dir}/big.log`, "x".repeat(600 * 1024));
    const big = (await w.artifacts.read(w.run.runId, "big.log"))._unsafeUnwrap();
    expect([big.kind, big.truncated, big.text.length]).toEqual(["text", true, 512 * 1024]);
    expect((await w.artifacts.list("nope")).isErr()).toBe(true);
  });
});

describe("artifact names and kinds", () => {
  test("kinds by extension; names that may be read", () => {
    expect(["a.json", "a.md", "a.yml", "a.yaml", "a.txt", "a.log", "a.bin"].map(artifactKind)).toEqual([
      "json",
      "markdown",
      "yaml",
      "yaml",
      "text",
      "text",
      undefined,
    ]);
    expect(artifactNameProblem("results/x.json")).toBeUndefined();
    expect(artifactNameProblem("./x.json")).toBe("a path out of the run directory");
    expect(artifactNameProblem("C:/x.json")).toBe("an absolute path");
    expect(artifactNameProblem("")).toBe("not a file name");
  });
  test("a cap cuts at a character boundary", () => {
    expect(capText("żółw", 3)).toEqual({ text: "ż", truncated: true });
    expect(capText("abc", 3)).toEqual({ text: "abc", truncated: false });
  });
});
