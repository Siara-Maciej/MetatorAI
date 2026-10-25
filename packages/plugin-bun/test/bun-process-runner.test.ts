import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processRunnerContract } from "@metator/testing";
import { BunProcessRunner } from "../src/bun-process-runner.ts";
import { findRepoRoot } from "../src/repo-root.ts";

processRunnerContract("BunProcessRunner", () => new BunProcessRunner());

describe("findRepoRoot", () => {
  test("walks up to the nearest directory with .git or a metator config", async () => {
    const root = await mkdtemp(join(tmpdir(), "metator-root-"));
    try {
      await mkdir(join(root, ".git"));
      await mkdir(join(root, "packages/a/src"), { recursive: true });
      expect(findRepoRoot(join(root, "packages/a/src"))).toBe(root);
      expect(findRepoRoot(root)).toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to the start directory when no marker exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "metator-noroot-"));
    try {
      expect(findRepoRoot(dir)).toBe(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
