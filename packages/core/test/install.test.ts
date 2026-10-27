import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { InstallCanon } from "../src/application/install.ts";
import { DEFAULT_PATHS, type MetatorPaths } from "../src/application/paths.ts";
import {
  contentHash,
  holdsCanon,
  InstallLockDocument,
  planInstall,
  writesFile,
} from "../src/domain/install.ts";

const lockOf = (files: Record<string, string>) => ({ version: "1", workflows: [], files });

describe("planInstall", () => {
  const h = (c: string) => c.repeat(64).slice(0, 64);

  test("one decision per file, sorted by path", () => {
    const plan = planInstall({
      canon: new Map([
        ["e", h("e")],
        ["a", h("a")],
        ["b", h("b")],
        ["c", h("c")],
        ["d", h("d")],
      ]),
      current: new Map([
        ["b", h("b")], // same as the canon
        ["c", h("0")], // untouched since the last install, canon moved on
        ["d", h("9")], // edited here, canon unchanged since the last install
        ["e", h("8")], // edited here and in the canon
      ]),
      lock: lockOf({ c: h("0"), d: h("d"), e: h("1") }),
      theirs: false,
    });
    expect(plan.steps).toEqual([
      { path: "a", action: "create" },
      { path: "b", action: "unchanged" },
      { path: "c", action: "update" },
      { path: "d", action: "kept" },
      { path: "e", action: "conflict" },
    ]);
  });

  test("--theirs overwrites conflicts but never a local edit of an unchanged canon file", () => {
    const plan = planInstall({
      canon: new Map([
        ["d", h("d")],
        ["e", h("e")],
      ]),
      current: new Map([
        ["d", h("9")],
        ["e", h("8")],
      ]),
      lock: lockOf({ d: h("d"), e: h("1") }),
      theirs: true,
    });
    expect(plan.steps.map((s) => s.action)).toEqual(["kept", "overwrite"]);
  });

  test("a file that exists without a lock is a conflict, not an update", () => {
    const plan = planInstall({
      canon: new Map([["a", h("a")]]),
      current: new Map([["a", h("b")]]),
      lock: undefined,
      theirs: false,
    });
    expect(plan.steps).toEqual([{ path: "a", action: "conflict" }]);
  });

  test("files the last install wrote that the canon dropped are reported", () => {
    const plan = planInstall({
      canon: new Map([["a", h("a")]]),
      current: new Map(),
      lock: lockOf({ a: h("a"), z: h("z"), y: h("y") }),
      theirs: false,
    });
    expect(plan.removedUpstream).toEqual(["y", "z"]);
  });

  test("what is written and what the lock records", () => {
    const actions = ["create", "unchanged", "update", "kept", "conflict", "overwrite"] as const;
    expect(actions.filter(writesFile)).toEqual(["create", "update", "overwrite"]);
    expect(actions.filter(holdsCanon)).toEqual(["create", "unchanged", "update", "overwrite"]);
  });
});

describe("InstallCanon", () => {
  const shipped = () =>
    new InMemoryFileSystem({
      "metator/agents/mt-scout.md": "scout v1\n",
      "metator/agents/partials/lens.md": "lens\n",
      "metator/skills/mt-grill/SKILL.md": "grill\n",
      ".github/metator/workflows/mt-feature.yml": "feature\n",
      ".github/metator/workflows/mt-bugfix.yml": "bugfix\n",
    });
  const source = (files = shipped()) => ({ files, location: "/opt/metator", version: "1.2.0" });
  const install = (fs: InMemoryFileSystem, src = source(), paths: MetatorPaths = DEFAULT_PATHS) =>
    new InstallCanon(src, fs, paths);

  test("install copies agents, skills and the chosen workflows and writes a versioned lock", async () => {
    const fs = new InMemoryFileSystem();
    const r = (
      await install(fs).execute({ mode: "install", workflows: ["mt-feature"], theirs: false, dryRun: false })
    )._unsafeUnwrap();
    expect([r.version, r.available, r.workflows, r.lock]).toEqual([
      "1.2.0",
      ["mt-bugfix", "mt-feature"],
      ["mt-feature"],
      "metator/install.lock.json",
    ]);
    expect(r.steps.every((s) => s.action === "create")).toBe(true);
    expect(await fs.glob(["**"])).toEqual([
      ".github/metator/workflows/mt-feature.yml",
      "metator/agents/mt-scout.md",
      "metator/agents/partials/lens.md",
      "metator/install.lock.json",
      "metator/skills/mt-grill/SKILL.md",
    ]);
    const lock = InstallLockDocument.parse(
      JSON.parse((await fs.read("metator/install.lock.json"))._unsafeUnwrap()),
      "lock",
    )._unsafeUnwrap();
    expect([lock.version, lock.workflows, Object.keys(lock.files).length]).toEqual([
      "1.2.0",
      ["mt-feature"],
      4,
    ]);
    expect(lock.files["metator/agents/mt-scout.md"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("writes to the repository's configured locations", async () => {
    const fs = new InMemoryFileSystem();
    const paths = { ...DEFAULT_PATHS, agents: "ai/agents", workflows: "ai/workflows" };
    await install(fs, source(), paths).execute({ mode: "install", theirs: false, dryRun: false });
    expect(await fs.exists("ai/agents/mt-scout.md")).toBe(true);
    expect(await fs.exists("ai/workflows/mt-bugfix.yml")).toBe(true);
  });

  test("a dry run writes nothing", async () => {
    const fs = new InMemoryFileSystem();
    const r = (await install(fs).execute({ mode: "install", theirs: false, dryRun: true }))._unsafeUnwrap();
    expect([r.lock, (await fs.glob(["**"])).length]).toEqual([null, 0]);
  });

  test("update takes a newer canon, keeps local edits and remembers the chosen workflows", async () => {
    const fs = new InMemoryFileSystem();
    await install(fs).execute({ mode: "install", workflows: ["mt-bugfix"], theirs: false, dryRun: false });
    await fs.write("metator/skills/mt-grill/SKILL.md", "grill, our way\n");
    const newer = shipped();
    await newer.write("metator/agents/mt-scout.md", "scout v2\n");
    const r = (
      await install(fs, { ...source(newer), version: "1.3.0" }).execute({
        mode: "update",
        theirs: false,
        dryRun: false,
      })
    )._unsafeUnwrap();
    expect(Object.fromEntries(r.steps.map((s) => [s.path, s.action]))).toEqual({
      ".github/metator/workflows/mt-bugfix.yml": "unchanged",
      "metator/agents/mt-scout.md": "update",
      "metator/agents/partials/lens.md": "unchanged",
      "metator/skills/mt-grill/SKILL.md": "kept",
    });
    expect((await fs.read("metator/agents/mt-scout.md"))._unsafeUnwrap()).toBe("scout v2\n");
    expect((await fs.read("metator/skills/mt-grill/SKILL.md"))._unsafeUnwrap()).toBe("grill, our way\n");
  });

  test("a file changed here and in the canon stays a conflict on the next update too", async () => {
    const fs = new InMemoryFileSystem();
    await install(fs).execute({ mode: "install", theirs: false, dryRun: false });
    await fs.write("metator/agents/mt-scout.md", "scout, ours\n");
    const newer = shipped();
    await newer.write("metator/agents/mt-scout.md", "scout v2\n");
    const update = (theirs: boolean) =>
      install(fs, source(newer)).execute({ mode: "update", theirs, dryRun: false });
    const action = async (theirs: boolean) =>
      (await update(theirs))._unsafeUnwrap().steps.find((s) => s.path === "metator/agents/mt-scout.md")
        ?.action;
    expect(await action(false)).toBe("conflict");
    expect(await action(false)).toBe("conflict");
    expect((await fs.read("metator/agents/mt-scout.md"))._unsafeUnwrap()).toBe("scout, ours\n");
    expect(await action(true)).toBe("overwrite");
    expect((await fs.read("metator/agents/mt-scout.md"))._unsafeUnwrap()).toBe("scout v2\n");
  });

  test("errors as values: twice installed, update without a lock, unknown workflow, no canon", async () => {
    const fs = new InMemoryFileSystem();
    const run = (mode: "install" | "update", workflows?: string[]) =>
      install(fs).execute({ mode, theirs: false, dryRun: false, ...(workflows ? { workflows } : {}) });
    expect((await run("update"))._unsafeUnwrapErr().message).toContain("was not installed");
    expect((await run("install", ["mt-nope"]))._unsafeUnwrapErr().message).toBe(
      "unknown workflow(s): mt-nope",
    );
    await run("install");
    expect((await run("install"))._unsafeUnwrapErr().code).toBe("USAGE");
    const none = await new InstallCanon(null, fs, DEFAULT_PATHS).execute({
      mode: "install",
      theirs: false,
      dryRun: false,
    });
    expect(none._unsafeUnwrapErr().code).toBe("NOT_FOUND");
  });
});

test("contentHash is the SHA-256 of the text", async () => {
  expect(await contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
