/**
 * init → config → gate end to end: the real `metator` process, a real git repository, scripts run
 * by the real package manager (bun) and a binary from node_modules/.bin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";
import { findUnversioned } from "./helpers/versioned.ts";

const SELF = join(import.meta.dir, "..");
type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const details = (r: { json: Record<string, unknown> }) => (r.json.error as { details: Data }).details;

let repo: ScratchRepo;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", "node_modules/\n.metator/\n");
  await repo.write(
    "package.json",
    JSON.stringify({
      name: "shop",
      scripts: {
        lint: "eslint",
        test: 'bun -e "process.exit(Number(process.env.FAIL_TESTS ?? 0))"',
      },
      devDependencies: { eslint: "9.0.0" },
    }),
  );
  await repo.write("bun.lock", "");
  await repo.write("eslint.config.js", "export default [];\n");
  // A stand-in for eslint: records the files it was given and fails on "bad" ones.
  await mkdir(repo.path("node_modules/.bin"), { recursive: true });
  await repo.write(
    "node_modules/.bin/eslint",
    '#!/bin/sh\necho "eslint $@" >> .metator-eslint.log\nfor f in "$@"; do case "$f" in *bad*) echo "$f: 1:1 error no-bad"; exit 1;; esac; done\n',
  );
  await chmod(repo.path("node_modules/.bin/eslint"), 0o755);
  await repo.write("src/a.ts", "export const a = 1;\n");
  await repo.commit("init");
});

afterAll(async () => {
  await repo.dispose();
});

describe("metator init", () => {
  test("proposes and writes a config from discovery; never overwrites", async () => {
    const r = await metator(["init"], repo.root);
    expect(r.code).toBe(0);
    expect(data(r).written).toBe("metator.config.yml");
    expect((data(r).decisions as Data[]).map((d) => `${d.gate}:${d.step}`)).toEqual([
      "full:script lint",
      "quick:script lint + files",
      "full:script test",
    ]);
    // Warnings go out once, in the envelope, never inside the data too (C11).
    expect(data(r).warnings).toBeUndefined();
    expect((await metator(["init"], repo.root)).code).toBe(64);
    expect((await metator(["init", "--dry-run"], repo.root)).code).toBe(0);
    const bare = await ScratchRepo.create();
    try {
      await bare.write("package.json", JSON.stringify({ name: "bare", scripts: { test: "true" } }));
      await bare.commit("init");
      const dry = await metator(["init", "--dry-run"], bare.root);
      expect(dry.json.warnings).toEqual(["no file-scoped checks found for the quick gate; add one by hand"]);
      expect(Object.keys(data(dry)).sort()).toEqual(["config", "decisions", "written"]);
    } finally {
      await bare.dispose();
    }
  });

  test("config show reports the file; an invalid config stops every command with the field", async () => {
    expect(data(await metator(["config", "show"], repo.root)).source).toBe("metator.config.yml");
    const good = await repo.read("metator.config.yml");
    await repo.write("metator.config.yml", good.replace("id: lint", "id: Lint"));
    try {
      const r = await metator(["rules", "lint"], repo.root);
      expect([r.code, (r.json.error as Data).code]).toEqual([1, "INVALID_CONFIG"]);
      expect(JSON.stringify(details(r).issues)).toContain("gates.quick.0.id");
    } finally {
      await repo.write("metator.config.yml", good);
    }
  });
});

describe("metator gate", () => {
  test("quick runs lint on the given files through the package manager", async () => {
    const r = await metator(["gate", "quick", "--files", "src/a.ts"], repo.root);
    expect(r.code).toBe(0);
    expect((data(r).steps as Data[]).map((s) => [s.id, s.status, s.command])).toEqual([
      ["lint", "pass", ["bun", "run", "lint", "src/a.ts"]],
    ]);
    expect(await repo.read(".metator-eslint.log")).toContain("eslint src/a.ts");
    expect((await findUnversioned(repo.root, [".metator/gates"])).unversioned).toEqual([]);
  });

  test("a failing file fails the gate with the tool's output; --base scopes to the branch", async () => {
    await repo.git("checkout", "-q", "-b", "feature");
    await repo.write("src/bad.ts", "export const b = 2;\n");
    try {
      const r = await metator(["gate", "quick", "--base", "main"], repo.root);
      expect(r.code).toBe(1);
      const step = (details(r).steps as Data[])[0] as Data;
      expect(step.status).toBe("fail");
      expect(step.detail).toContain("src/bad.ts: 1:1 error no-bad");
      expect(step.command).toEqual(["bun", "run", "lint", "src/bad.ts"]); // the log and YAML are not linted
      expect(details(r).files).toContain("src/bad.ts");
    } finally {
      await Bun.file(repo.path("src/bad.ts")).delete();
      await repo.git("checkout", "-q", "main");
    }
  });

  test("full runs the project's scripts; every step is reported", async () => {
    const ok = await metator(["gate", "full"], repo.root);
    expect([ok.code, (data(ok).steps as Data[]).map((s) => s.status)]).toEqual([0, ["pass", "pass"]]);
    const red = await metator(["gate", "full"], repo.root, { FAIL_TESTS: "3" });
    expect(red.code).toBe(1);
    expect((details(red).steps as Data[]).map((s) => [s.id, s.status, s.exitCode])).toEqual([
      ["lint", "pass", 0],
      ["test", "fail", 3],
    ]);
  });

  test("unknown gate names are usage errors; an empty gate is a config problem and says how to fill it", async () => {
    expect((await metator(["gate", "slow"], repo.root)).code).toBe(64);
    const empty = await ScratchRepo.create();
    try {
      const r = await metator(["gate", "quick"], empty.root);
      expect([r.code, (r.json.error as Data).code, (r.json.error as Data).hint]).toEqual([
        1,
        "INVALID_CONFIG",
        expect.stringContaining("metator init"),
      ]);
      // With a config, `init` would refuse: the hint names the key to add and a step to copy.
      await empty.write("metator.config.yml", "kind: MetatorConfig\nschemaVersion: 1\ngates:\n  quick: []\n");
      const configured = await metator(["gate", "quick"], empty.root);
      const hint = String((configured.json.error as Data).hint);
      expect((configured.json.error as Data).code).toBe("INVALID_CONFIG");
      expect(hint).toContain("`gates.quick:` in metator.config.yml");
      expect(hint).toContain("- { id: test, run: { script: test } }");
      expect(hint).not.toContain("metator init");
      const doctor = await metator(["doctor"], empty.root);
      const gates = (doctor.json.data as { checks: { id: string; fix?: string }[] }).checks.find(
        (c) => c.id === "gates",
      );
      expect(gates?.fix).toContain("`gates.full:` in metator.config.yml");
      // The step from the hint is a valid one.
      await empty.write("package.json", '{ "name": "x", "scripts": { "test": "true" } }\n');
      await empty.write(
        "metator.config.yml",
        "kind: MetatorConfig\nschemaVersion: 1\ngates:\n  quick:\n    - { id: test, run: { script: test } }\n",
      );
      expect((await metator(["gate", "quick"], empty.root)).code).toBe(0);
    } finally {
      await empty.dispose();
    }
  }, 30_000);

  test("dogfood: MetatorAI's quick gate passes on a clean file", async () => {
    const r = await metator(
      ["gate", "quick", "--files", "packages/core/src/domain/gate.ts", "--root", SELF],
      SELF,
    );
    expect([r.code, (data(r).steps as Data[]).map((s) => s.id)]).toEqual([0, ["lint", "rules", "typecheck"]]);
  }, 120_000);
});
