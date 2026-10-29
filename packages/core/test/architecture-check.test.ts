import { describe, expect, test } from "bun:test";
import { FakeVcs, InMemoryFileSystem } from "@metator/testing";
import {
  ArchitectureBaselineStore,
  BaseArchitectureFacts,
  CheckArchitecture,
  InitArchitecturePolicy,
  RecordArchitectureBaseline,
  resolveAmong,
} from "../src/application/architecture.ts";
import {
  type ArchitectureInput,
  type ArchitectureReport,
  analyzeArchitecture,
  manifestOf,
  type Violation,
} from "../src/domain/architecture.ts";
import {
  architectureSarif,
  baselineOf,
  compareArchitecture,
  proposePolicy,
  rulesFromNxEslint,
  rulesFromTurbo,
  tightenBaseline,
} from "../src/domain/architecture-check.ts";
import { ArchitecturePolicySchema, EMPTY_POLICY } from "../src/domain/architecture-policy.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import type { ImportAnalyzer } from "../src/ports/index.ts";

const v = (
  id: string,
  severity: "error" | "warning" = "error",
  exception?: Violation["exception"],
): Violation => ({
  id,
  kind: id.split(":")[0] as Violation["kind"],
  severity,
  message: `msg ${id}`,
  packages: [],
  evidence: [{ file: "packages/a/src/x.ts" }],
  ...(exception ? { exception } : {}),
});
const report = (violations: Violation[]): ArchitectureReport => ({
  policy: null,
  summary: { packages: 0, apps: 0, edges: 0, cycles: 0, errors: 0, warnings: 0, excepted: 0, score: 100 },
  packages: [],
  edges: [],
  cycles: [],
  violations,
  unresolved: { count: 0, sample: [] },
});
const EXC = { reason: "r", owner: "o", expires: "2027-01-01" };

describe("baselines", () => {
  test("a baseline holds every counting violation once, by id, sorted; excepted ones stay out", () => {
    expect(
      baselineOf(report([v("undeclared:b"), v("cycle:a", "warning"), v("layer:c", "error", EXC)])),
    ).toEqual({
      violations: [
        { id: "cycle:a", kind: "cycle" },
        { id: "undeclared:b", kind: "undeclared" },
      ],
    });
  });

  test("tightening drops what no longer occurs and never adds", () => {
    const baseline = {
      violations: [
        { id: "cycle:a", kind: "cycle" as const },
        { id: "layer:b", kind: "layer" as const },
      ],
    };
    expect(tightenBaseline(baseline, report([v("layer:b"), v("undeclared:new")]))).toEqual({
      violations: [{ id: "layer:b", kind: "layer" }],
    });
  });
});

describe("compareArchitecture", () => {
  const current = report([v("cycle:a"), v("layer:b"), v("unlayered:c", "warning"), v("tag:d", "error", EXC)]);

  test("without a base or a baseline, every counting violation is new; errors fail", () => {
    const c = compareArchitecture({ current });
    expect(c.added.map((x) => x.id)).toEqual(["cycle:a", "layer:b", "unlayered:c"]);
    expect(c.failing.map((x) => x.id)).toEqual(["cycle:a", "layer:b"]);
    expect(c.fixed).toEqual([]);
  });

  test("what the base already had or the baseline accepted is not new; fixed baseline entries are named", () => {
    const c = compareArchitecture({
      current,
      base: report([v("cycle:a")]),
      baseline: {
        violations: [
          { id: "layer:b", kind: "layer" },
          { id: "app-import:z", kind: "app-import" },
        ],
      },
    });
    expect(c.added.map((x) => x.id)).toEqual(["unlayered:c"]);
    expect(c.failing).toEqual([]);
    expect(c.fixed).toEqual(["app-import:z"]);
  });

  test("an excepted violation at the base does not hide the same one in the change", () => {
    const c = compareArchitecture({
      current: report([v("cycle:a")]),
      base: report([v("cycle:a", "error", EXC)]),
    });
    expect(c.failing.map((x) => x.id)).toEqual(["cycle:a"]);
  });

  test("strict: new warnings fail too", () => {
    expect(compareArchitecture({ current, strict: true }).failing.map((x) => x.id)).toEqual([
      "cycle:a",
      "layer:b",
      "unlayered:c",
    ]);
  });
});

describe("architectureSarif", () => {
  test("one result per violation, at its first evidence file, with a stable fingerprint", () => {
    const sarif = architectureSarif(
      [v("cycle:a"), { ...v("version-drift:z", "warning"), evidence: [] }],
      "metator/architecture.yml",
    ) as {
      version: string;
      runs: {
        tool: { driver: { name: string; rules: { id: string }[] } };
        results: {
          ruleId: string;
          level: string;
          partialFingerprints: unknown;
          locations: { physicalLocation: { artifactLocation: { uri: string } } }[];
        }[];
      }[];
    };
    expect(sarif.version).toBe("2.1.0");
    const run = sarif.runs[0];
    expect(run?.tool.driver.name).toBe("metator-arch");
    expect(run?.tool.driver.rules.map((r) => r.id)).toEqual(["arch/cycle", "arch/version-drift"]);
    expect(
      run?.results.map((r) => [r.ruleId, r.level, r.locations[0]?.physicalLocation.artifactLocation.uri]),
    ).toEqual([
      ["arch/cycle", "error", "packages/a/src/x.ts"],
      ["arch/version-drift", "warning", "metator/architecture.yml"],
    ]);
    expect(run?.results[0]?.partialFingerprints).toEqual({ metatorArchId: "cycle:a" });
    const bare = architectureSarif([{ ...v("cycle:a"), evidence: [] }], null) as typeof sarif;
    expect(bare.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri).toBe(
      "package.json",
    );
  });
});

describe("rules from other tools", () => {
  test("Turborepo boundaries: dependencies become from rules, dependents become to rules", () => {
    expect(
      rulesFromTurbo({
        boundaries: {
          tags: {
            "type:ui": { dependencies: { allow: ["type:util"], deny: ["type:db"] } },
            "type:internal": { dependents: { allow: ["scope:billing"] } },
            "type:empty": { dependencies: {} },
            "bad tag": "nope",
          },
        },
      }),
    ).toEqual([
      { to: "type:internal", allow: ["scope:billing"] },
      { from: "type:ui", allow: ["type:util"], deny: ["type:db"] },
    ]);
    expect(rulesFromTurbo({})).toEqual([]);
    expect(rulesFromTurbo(null)).toEqual([]);
  });

  test("Nx depConstraints from the rules or the overrides of an ESLint JSON config", () => {
    const constraint = [
      "error",
      {
        depConstraints: [
          { sourceTag: "scope:shop", onlyDependOnLibsWithTags: ["scope:shop", "scope:shared"] },
          { sourceTag: "type:ui", notDependOnLibsWithTags: ["type:data"] },
          { sourceTag: "type:x" },
          { onlyDependOnLibsWithTags: ["a"] },
        ],
      },
    ];
    const expected = [
      { from: "scope:shop", allow: ["scope:shop", "scope:shared"] },
      { from: "type:ui", deny: ["type:data"] },
    ];
    expect(rulesFromNxEslint({ rules: { "@nx/enforce-module-boundaries": constraint } })).toEqual(expected);
    expect(
      rulesFromNxEslint({ overrides: [{ rules: { "@nrwl/nx/enforce-module-boundaries": constraint } }] }),
    ).toEqual(expected);
    expect(rulesFromNxEslint({ rules: { "@nx/enforce-module-boundaries": "error" } })).toEqual([]);
  });
});

describe("proposePolicy", () => {
  test("applications above libraries, plus the rules other tools enforce; notes say what it is based on", () => {
    const r = analyzeArchitecture(input());
    const proposal = proposePolicy(r, [
      { source: "turbo.json", rules: [{ from: "type:ui", deny: ["type:db"] }] },
    ]);
    expect(proposal.body).toEqual({
      layers: [
        { name: "apps", packages: ["@x/web"] },
        { name: "libs", packages: ["@x/core"] },
      ],
      rules: [{ from: "type:ui", deny: ["type:db"] }],
    });
    expect(proposal.notes).toEqual([
      "1 application(s), 1 library, 0 cycle(s) found.",
      "1 rule(s) imported from turbo.json.",
      "Split libs into the layers you intend (e.g. features, domain, shared); `metator arch analyze` shows what breaks.",
    ]);
    expect(ArchitecturePolicySchema.parse(proposal.body).layers).toHaveLength(2);
    expect(proposePolicy(report([]), []).body).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------

const WEB = manifestOf("apps/web", { name: "@x/web", dependencies: { "@x/core": "*" } });
const CORE = manifestOf("packages/core", { name: "@x/core", main: "x" });
function input(over: Partial<ArchitectureInput> = {}): ArchitectureInput {
  return {
    files: ["apps/web/src/main.ts", "packages/core/src/money.ts"],
    imports: [
      {
        from: "apps/web/src/main.ts",
        to: "packages/core/src/money.ts",
        specifier: "@x/core",
        typeOnly: false,
      },
    ],
    externals: [],
    unresolved: [],
    manifests: { packages: [WEB, CORE] },
    policy: EMPTY_POLICY,
    policySource: null,
    today: "2026-10-29",
    ...over,
  };
}
const facts = (i: ArchitectureInput) => ({ gather: async () => ok(i) });

describe("ArchitectureBaselineStore", () => {
  test("no file is no baseline; a saved baseline reads back; a broken one is INVALID_CONFIG", async () => {
    const fs = new InMemoryFileSystem();
    const store = new ArchitectureBaselineStore(fs, "metator/arch-baseline.json");
    expect((await store.load())._unsafeUnwrap()).toBeUndefined();
    await store.save({ violations: [{ id: "cycle:a", kind: "cycle" }] });
    expect(JSON.parse((await fs.read("metator/arch-baseline.json"))._unsafeUnwrap())).toMatchObject({
      kind: "ArchitectureBaseline",
      schemaVersion: 1,
    });
    expect((await store.load())._unsafeUnwrap()).toEqual({ violations: [{ id: "cycle:a", kind: "cycle" }] });
    await fs.write(
      "metator/arch-baseline.json",
      '{"kind":"ArchitectureBaseline","schemaVersion":1,"violations":[{"id":"x"}]}',
    );
    expect((await store.load())._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
  });
});

class FakeHistory {
  constructor(private readonly files: Record<string, string | undefined>) {}
  async readAt(_base: string, path: string) {
    return ok(this.files[path]);
  }
}
/** Each line `import "spec"` is one import; specs with a slash resolve to that file. */
const analyzer: ImportAnalyzer = {
  extensions: [".ts"],
  fingerprint: (c) => c,
  parse: (_p, content) =>
    content.startsWith("!")
      ? err(new MetatorError("PARSE_FAILED", "broken"))
      : ok(
          [...content.matchAll(/import "([^"]+)"/g)].map((m) => ({
            specifier: m[1] as string,
            kind: "static" as const,
            typeOnly: false,
          })),
        ),
  resolve: (_from, specifier) =>
    specifier.includes("/") ? { type: "file", path: specifier } : { type: "external", name: specifier },
};

describe("BaseArchitectureFacts", () => {
  test("a file renamed on the branch: its base imports resolve to the base's files, not today's tree", async () => {
    // Base: a/index.ts → b/x.ts → a/index.ts (a cycle). Branch: x.ts renamed to y.ts, cycle kept.
    const current = input({
      files: ["packages/core/src/a.ts", "packages/core/src/y.ts"],
      imports: [
        {
          from: "packages/core/src/a.ts",
          to: "packages/core/src/y.ts",
          specifier: "./y.ts",
          typeOnly: false,
        },
      ],
      externals: [],
    });
    const history = new FakeHistory({
      "packages/core/src/a.ts": 'import "./x.js"',
      "packages/core/src/x.ts": 'import "./a.ts"',
      "packages/core/src/y.ts": undefined,
    });
    const vcs = new FakeVcs(
      [],
      ["packages/core/src/a.ts", "packages/core/src/x.ts", "packages/core/src/y.ts"],
    );
    const relative = {
      ...analyzer,
      resolve: (from: string, specifier: string) => {
        const target = resolveAmong(from, specifier, new Set(current.files), [".ts"]);
        return target ? { type: "file" as const, path: target } : { type: "unresolved" as const };
      },
    };
    const at = (await new BaseArchitectureFacts(vcs, history, relative).at(current, "main"))._unsafeUnwrap();
    expect([...at.files].sort()).toEqual(["packages/core/src/a.ts", "packages/core/src/x.ts"]);
    expect(at.imports.map((i) => [i.from, i.to])).toEqual([
      ["packages/core/src/a.ts", "packages/core/src/x.ts"],
      ["packages/core/src/x.ts", "packages/core/src/a.ts"],
    ]);
    expect(resolveAmong("p/src/a.ts", "../lib", new Set(["p/lib/index.ts"]), [".ts"])).toBe("p/lib/index.ts");
    expect(resolveAmong("p/src/a.ts", "zod", new Set(["zod"]), [".ts"])).toBeUndefined();
  });

  test("changed files import and changed manifests declare as they did at the base", async () => {
    const current = input({
      files: [...input().files, "packages/core/src/new.ts"],
      imports: [
        ...input().imports,
        {
          from: "packages/core/src/money.ts",
          to: "apps/web/src/main.ts",
          specifier: "@x/web",
          typeOnly: false,
        },
      ],
      externals: [{ from: "packages/core/src/money.ts", name: "lodash", typeOnly: false }],
      manifests: {
        root: manifestOf(".", { name: "r" }),
        packages: [WEB, CORE, manifestOf("packages/added", { name: "@x/added" })],
      },
    });
    const history = new FakeHistory({
      "packages/core/src/money.ts": 'import "zod"\nimport "packages/core/src/old.ts"',
      "packages/core/src/new.ts": undefined,
      "packages/core/package.json": '{"name":"@x/core","dependencies":{"zod":"1"}}',
      "packages/added/package.json": undefined,
      "package.json": "not json",
    });
    const vcs = new FakeVcs(
      [],
      [
        "packages/core/src/money.ts",
        "packages/core/src/new.ts",
        "packages/core/package.json",
        "packages/added/package.json",
        "package.json",
        "README.md",
      ],
    );
    const at = (await new BaseArchitectureFacts(vcs, history, analyzer).at(current, "main"))._unsafeUnwrap();
    expect(at.files).toEqual(["apps/web/src/main.ts", "packages/core/src/money.ts"]);
    expect(at.imports).toEqual([
      ...input().imports,
      {
        from: "packages/core/src/money.ts",
        to: "packages/core/src/old.ts",
        specifier: "packages/core/src/old.ts",
        typeOnly: false,
      },
    ]);
    expect(at.externals).toEqual([{ from: "packages/core/src/money.ts", name: "zod", typeOnly: false }]);
    expect(at.manifests.packages.map((m) => [m.name, m.dependencies])).toEqual([
      ["@x/web", { "@x/core": "*" }],
      ["@x/core", { zod: "1" }],
    ]);
    expect(at.manifests.root?.name).toBe("r");
  });

  test("an unparsable file at the base adds no imports; a failing history is the error", async () => {
    const vcs = new FakeVcs([], ["packages/core/src/money.ts"]);
    const broken = new FakeHistory({ "packages/core/src/money.ts": "!broken" });
    const at = (await new BaseArchitectureFacts(vcs, broken, analyzer).at(input(), "main"))._unsafeUnwrap();
    expect(at.imports).toEqual(input().imports);
    const failing = { readAt: async () => err(new MetatorError("COMMAND_FAILED", "git show failed")) };
    const e = (
      await new BaseArchitectureFacts(vcs, failing, analyzer).at(input(), "main")
    )._unsafeUnwrapErr();
    expect(e.message).toBe("git show failed");
    const noRepo = new FakeVcs("not-a-repo");
    expect((await new BaseArchitectureFacts(noRepo, broken, analyzer).at(input(), "main")).isErr()).toBe(
      true,
    );
  });
});

describe("CheckArchitecture", () => {
  const cyclic = input({
    imports: [
      ...input().imports,
      {
        from: "packages/core/src/money.ts",
        to: "apps/web/src/main.ts",
        specifier: "@x/web",
        typeOnly: false,
      },
    ],
  });

  test("a violation the change adds fails; the base's own do not; SARIF is written on request", async () => {
    const fs = new InMemoryFileSystem();
    const check = new CheckArchitecture(
      facts(cyclic),
      { at: async () => ok(input()) },
      new ArchitectureBaselineStore(fs, "b.json"),
      fs,
    );
    const r = (await check.execute({ base: "main", sarif: "out/arch.sarif" }))._unsafeUnwrap();
    expect(r.base).toBe("main");
    expect(r.baseline).toBeNull();
    expect(r.failing.map((x) => x.id)).toEqual([
      "app-import:@x/core→@x/web",
      "cycle:@x/core,@x/web",
      "undeclared:@x/core→@x/web",
    ]);
    expect(r.sarif).toBe("out/arch.sarif");
    expect(JSON.parse((await fs.read("out/arch.sarif"))._unsafeUnwrap()).runs[0].results).toHaveLength(3);

    const same = new CheckArchitecture(
      facts(cyclic),
      { at: async () => ok(cyclic) },
      new ArchitectureBaselineStore(fs, "b.json"),
      fs,
    );
    expect((await same.execute({ base: "main" }))._unsafeUnwrap().failing).toEqual([]);
  });

  test("without a base, the baseline decides; a broken baseline or base is the error", async () => {
    const fs = new InMemoryFileSystem();
    const store = new ArchitectureBaselineStore(fs, "b.json");
    await store.save(baselineOf(analyzeArchitecture(cyclic)));
    const never = { at: async () => err(new MetatorError("INTERNAL", "no base")) };
    const r = (await new CheckArchitecture(facts(cyclic), never, store, fs).execute({}))._unsafeUnwrap();
    expect([r.baseline, r.failing, r.base]).toEqual(["b.json", [], null]);
    expect(
      (await new CheckArchitecture(facts(cyclic), never, store, fs).execute({ base: "x" }))._unsafeUnwrapErr()
        .message,
    ).toBe("no base");
    await fs.write("b.json", "{");
    expect((await new CheckArchitecture(facts(cyclic), never, store, fs).execute({})).isErr()).toBe(true);
  });
});

describe("RecordArchitectureBaseline", () => {
  test("records the current violations; tightening drops fixed ones and needs a baseline", async () => {
    const fs = new InMemoryFileSystem();
    const store = new ArchitectureBaselineStore(fs, "b.json");
    const cyclic = input({
      imports: [
        ...input().imports,
        {
          from: "packages/core/src/money.ts",
          to: "apps/web/src/main.ts",
          specifier: "@x/web",
          typeOnly: false,
        },
      ],
    });
    const tight = (
      await new RecordArchitectureBaseline(facts(cyclic), store).execute({ tighten: true })
    )._unsafeUnwrapErr();
    expect([tight.code, tight.message]).toEqual(["USAGE", "b.json does not exist"]);
    expect((await new RecordArchitectureBaseline(facts(cyclic), store).execute({}))._unsafeUnwrap()).toEqual({
      file: "b.json",
      violations: 3,
      dropped: 0,
    });
    expect(
      (
        await new RecordArchitectureBaseline(facts(input()), store).execute({ tighten: true })
      )._unsafeUnwrap(),
    ).toEqual({
      file: "b.json",
      violations: 0,
      dropped: 3,
    });
  });
});

describe("InitArchitecturePolicy", () => {
  test("writes a proposal with its header and notes; never overwrites", async () => {
    const fs = new InMemoryFileSystem();
    const tools = {
      read: async () => ok([{ source: "turbo.json", rules: [{ from: "type:ui", deny: ["type:db"] }] }]),
    };
    const init = new InitArchitecturePolicy(facts(input()), tools, fs, "metator/architecture.yml");
    const r = (await init.execute())._unsafeUnwrap();
    expect(r.file).toBe("metator/architecture.yml");
    const text = (await fs.read("metator/architecture.yml"))._unsafeUnwrap();
    expect(text).toStartWith("# How packages may depend on each other (metator arch). 1 application(s)");
    expect(text).toContain("kind: ArchitecturePolicy\nschemaVersion: 1\nlayers:\n  - name: apps\n");
    expect(text).toContain("deny:\n      - type:db");
    const again = (await init.execute())._unsafeUnwrapErr();
    expect([again.code, again.message]).toEqual(["USAGE", "metator/architecture.yml already exists"]);
  });
});
