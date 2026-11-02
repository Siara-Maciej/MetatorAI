import { describe, expect, test } from "bun:test";
import {
  CheckReadiness,
  DEFAULT_CONFIG,
  DEFAULT_PATHS,
  RUN_READINESS,
  readinessWarnings,
} from "@metator/core";
import { FakeVcs } from "@metator/testing";

const present = (...paths: string[]) => ({ exists: async (p: string) => paths.includes(p) });
const catalog = (...ids: string[]) => ({
  scan: async () => ({ workflows: ids.map((id) => ({ spec: { id } })), problems: [] }) as never,
});
const gated = {
  ...DEFAULT_CONFIG,
  gates: { quick: [], full: [{ id: "rules", run: "rules check" }] },
} as never;

describe("CheckReadiness", () => {
  test("a set-up repository with its dependencies, gates and a remote is ready without warnings", async () => {
    const r = await new CheckReadiness(
      present("metator/install.lock.json", "package.json"),
      DEFAULT_PATHS,
      { config: gated, source: "metator.config.yml" },
      catalog("mt-feature", "mt-bugfix"),
      new FakeVcs([], [], "git@example.com:a/b.git"),
      async () => true,
    ).execute();
    const v = r._unsafeUnwrap();
    expect(v.ready).toBe(true);
    expect(v.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      "config:ok",
      "canon:ok",
      "workflows:ok",
      "gates:ok",
      "dependencies:ok",
      "remote:ok",
    ]);
    expect(readinessWarnings(v)).toEqual([]);
  });

  test("what a run will not do: no dependencies (with the lockfile's install), no gates, no remote", async () => {
    const r = await new CheckReadiness(
      present("package.json", "pnpm-lock.yaml"),
      DEFAULT_PATHS,
      { config: DEFAULT_CONFIG },
      catalog("mt-feature"),
      new FakeVcs([]),
      async () => false,
    ).execute();
    const v = r._unsafeUnwrap();
    expect(v.ready).toBe(true); // warnings only: a run starts, and does less
    expect(readinessWarnings(v)).toEqual([
      "config: no metator.config: MetatorAI's defaults apply (no gates, every host) (fix: metator init)",
      "canon: the agents and skills are not installed by MetatorAI here (fix: metator setup)",
      "gates: no gates configured: a run's gates stage checks nothing (fix: metator init (it proposes gates from the repository's scripts))",
      "dependencies: dependencies are not installed: in a run, tests, the type checker and linters cannot run, so gates check only rules (fix: pnpm install)",
      "remote: no git remote: a run's publish stage cannot push its branch (fix: git remote add origin <url>)",
    ]);
  });

  test("a run carries only what it will not do: gates, dependencies, remote", async () => {
    const v = (
      await new CheckReadiness(
        present("package.json"),
        DEFAULT_PATHS,
        { config: DEFAULT_CONFIG },
        catalog("w"),
        new FakeVcs([]),
        async () => false,
      ).execute()
    )._unsafeUnwrap();
    expect(readinessWarnings(v, RUN_READINESS).map((w) => w.split(":")[0])).toEqual([
      "gates",
      "dependencies",
      "remote",
    ]);
  });

  test("no workflow fails: nothing a run could follow; a project without a lockfile installs with npm", async () => {
    const v = (
      await new CheckReadiness(
        present("package.json"),
        DEFAULT_PATHS,
        { config: DEFAULT_CONFIG },
        catalog(),
        new FakeVcs("not-a-repo"),
        async () => false,
      ).execute()
    )._unsafeUnwrap();
    expect(v.ready).toBe(false);
    expect(v.checks.find((c) => c.id === "workflows")?.status).toBe("fail");
    expect(v.checks.find((c) => c.id === "dependencies")?.fix).toBe("npm install");
    expect(v.checks.find((c) => c.id === "remote")?.status).toBe("warn");
  });

  test("a repository that is not a Node project has nothing to install", async () => {
    const v = (
      await new CheckReadiness(
        present(),
        DEFAULT_PATHS,
        { config: DEFAULT_CONFIG },
        catalog("w"),
        new FakeVcs([]),
        async () => false,
      ).execute()
    )._unsafeUnwrap();
    expect(v.checks.find((c) => c.id === "dependencies")).toEqual({
      id: "dependencies",
      status: "ok",
      message: "not a Node project: nothing to install",
    });
  });
});
