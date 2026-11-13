import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  DEFAULT_PATHS,
  deleteYamlPaths,
  LOCAL_STATE_PATHS,
  MetatorConfigDocument,
  OptionStore,
  RunRepository,
  UpdateConfig,
} from "@metator/core";
import { InMemoryFileSystem, InMemoryMachineState } from "@metator/testing";
import { parse } from "yaml";

/** F3: the local state always lives under `.metator/`; MetatorConfig v12 has no override for it. */
describe("MetatorConfig v12: no path override for the local state", () => {
  test("a v11 file that moved runs and gates reads as v12 without them; the canon's paths stay", () => {
    const v11 = MetatorConfigDocument.parse(
      {
        kind: "MetatorConfig",
        schemaVersion: 11,
        paths: { runs: "state/runs", index: "i", discovery: "d.json", gates: "g", rules: "docs/rules" },
      },
      "metator.config.yml",
    )._unsafeUnwrap();
    expect(v11.paths).toEqual({ rules: "docs/rules" });
    expect(MetatorConfigDocument.current).toBe(12);
    expect([...LOCAL_STATE_PATHS]).toEqual(["runs", "index", "discovery", "gates"]);
  });

  test("a v12 file that sets one is invalid, and the error names the key", () => {
    for (const key of LOCAL_STATE_PATHS) {
      const error = MetatorConfigDocument.parse(
        { kind: "MetatorConfig", schemaVersion: 12, paths: { [key]: "elsewhere" } },
        "metator.config.yml",
      )._unsafeUnwrapErr();
      expect([error.code, error.message.includes(key)]).toEqual(["INVALID_CONFIG", true]);
    }
    const canon = { kind: "MetatorConfig", schemaVersion: 12, paths: { workflows: "wf", adr: "adr" } };
    expect(MetatorConfigDocument.parse(canon, "c")._unsafeUnwrap().paths).toEqual({
      workflows: "wf",
      adr: "adr",
    });
  });

  const OLD = `kind: MetatorConfig
schemaVersion: 11
# ours
paths:
  runs: state/runs # moved
  rules: docs/rules
`;

  test("a setting saved into a v11 YAML file drops the keys v12 does not have and stays valid", async () => {
    const fs = new InMemoryFileSystem({ "metator.config.yml": OLD });
    (await new UpdateConfig(fs).execute({ editor: "zed" }))._unsafeUnwrap();
    const text = (await fs.read("metator.config.yml"))._unsafeUnwrap();
    expect(text).toContain("# ours");
    expect(parse(text)).toEqual({
      kind: "MetatorConfig",
      schemaVersion: 12,
      paths: { rules: "docs/rules" },
      editor: "zed",
    });
  });

  test("the same for a JSON file and for an option set at repository scope", async () => {
    const json = new InMemoryFileSystem({
      "metator.config.json": JSON.stringify({
        kind: "MetatorConfig",
        schemaVersion: 11,
        paths: { gates: "g", cards: "cards" },
      }),
    });
    (await new UpdateConfig(json).execute({ editor: "zed" }))._unsafeUnwrap();
    expect(JSON.parse((await json.read("metator.config.json"))._unsafeUnwrap())).toEqual({
      kind: "MetatorConfig",
      schemaVersion: 12,
      paths: { cards: "cards" },
      editor: "zed",
    });
    for (const [file, text] of [
      ["metator.config.yml", OLD],
      [
        "metator.config.json",
        JSON.stringify({ kind: "MetatorConfig", schemaVersion: 11, paths: { runs: "r" } }),
      ],
    ] as const) {
      const fs = new InMemoryFileSystem({ [file]: text });
      const store = new OptionStore({
        fs,
        user: new InMemoryMachineState(),
        config: DEFAULT_CONFIG,
        configFile: file,
        runs: new RunRepository(fs, DEFAULT_PATHS),
      });
      (await store.set({ key: "supervisor.wipLimit", scope: "repo", text: "2" }))._unsafeUnwrap();
      const saved = (await fs.read(file))._unsafeUnwrap();
      const doc = file.endsWith(".json") ? JSON.parse(saved) : parse(saved);
      expect([file, doc.schemaVersion, doc.paths.runs, doc.options]).toEqual([
        file,
        12,
        undefined,
        { "supervisor.wipLimit": 2 },
      ]);
      expect(MetatorConfigDocument.parse(doc, file).isOk()).toBe(true);
    }
  });

  test("deleteYamlPaths removes only what is there", () => {
    expect(deleteYamlPaths("a: 1\n", [["paths", "runs"]])).toBe("a: 1\n");
    expect(parse(deleteYamlPaths("paths:\n  runs: r\n  adr: a\n", [["paths", "runs"]]))).toEqual({
      paths: { adr: "a" },
    });
  });
});
