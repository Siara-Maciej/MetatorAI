import { describe, expect, test } from "bun:test";
import {
  BooleanOption,
  DEFAULT_CONFIG,
  EnumOption,
  isKeyChord,
  KeybindingOption,
  ListOption,
  type MetatorConfig,
  MetatorConfigSchema,
  NumberOption,
  OPTIONS,
  optionByKey,
  optionGroup,
  optionsJsonSchema,
  resolveOptions,
  UserOptionsDocument,
} from "@metator/core";

const spec = <T>(key: string, defaultValue: T, scope: "user" | "repo" = "user") => ({
  key,
  scope,
  title: key,
  description: `${key} does something`,
  defaultValue,
});

describe("option definitions", () => {
  test("each kind reads what a person types and refuses what does not fit", () => {
    const b = new BooleanOption(spec("ui.x", true));
    expect(b.parseText("off")).toEqual({ ok: true, value: false });
    expect(b.parseText("yes")).toEqual({ ok: true, value: true });
    expect(b.parseText("maybe").ok).toBe(false);
    const e = new EnumOption(spec("ui.y", "auto"), ["auto", "always", "off"]);
    expect(e.parseText(" always ")).toEqual({ ok: true, value: "always" });
    expect(e.parseText("sometimes").ok).toBe(false);
    expect(e.describe().choices).toEqual(["auto", "always", "off"]);
    const n = new NumberOption(spec("ui.w", 230), { min: 160, max: 480, unit: "px" });
    expect(n.parseText("300")).toEqual({ ok: true, value: 300 });
    expect(n.parseText("100").ok).toBe(false);
    expect(n.parseText("wide").ok).toBe(false);
    expect(n.parseText("12.5").ok).toBe(false);
    expect(n.describe()).toMatchObject({ kind: "number", min: 160, max: 480, unit: "px" });
    const l = new ListOption(spec("hosts.order", ["a"]));
    expect(l.parseText("copilot, claude,,")).toEqual({ ok: true, value: ["copilot", "claude"] });
    const k = new KeybindingOption(spec("keys.zoom", ["prefix+z"]));
    expect(k.parseText("prefix+z, ctrl+shift+f5")).toEqual({
      ok: true,
      value: ["prefix+z", "ctrl+shift+f5"],
    });
    expect(k.parse("prefix+[")).toEqual({ ok: true, value: ["prefix+["] });
    expect(k.parse("ctrl+").ok).toBe(false);
    expect(k.parse([]).ok).toBe(false);
    expect(isKeyChord("ctrl+b")).toBe(true);
    expect(isKeyChord("prefix+escape")).toBe(true);
    expect(isKeyChord("ctrl+")).toBe(false);
    expect(isKeyChord("ctrl b")).toBe(false);
  });

  test("the registry: unique keys, a description and a valid default for every option, groups by the first segment", () => {
    const keys = OPTIONS.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const o of OPTIONS) {
      expect(o.key).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
      expect(o.spec.description.length).toBeGreaterThan(10);
      expect(o.parse(o.defaultValue).ok).toBe(true);
      expect(o.describe().title.length).toBeGreaterThan(0);
    }
    expect(optionGroup("ui.paneBorders")).toBe("ui");
    expect(optionByKey("keys.zoom")?.defaultValue).toEqual(["prefix+z"]);
    expect(optionByKey("issues.requireConsent")?.fixed).toBe(true);
    const schema = optionsJsonSchema(OPTIONS) as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties["ui.paneBorders"]).toMatchObject({
      enum: ["auto", "always", "off"],
      "x-scope": "user",
    });
    expect(schema.properties["issues.requireConsent"]).toMatchObject({ readOnly: true });
    expect(schema.properties["supervisor.hostOrder"]).toMatchObject({ "x-restart": "daemon" });
  });
});

describe("resolveOptions", () => {
  const defs = [
    new EnumOption(spec("ui.paneBorders", "auto"), ["auto", "always", "off"]),
    new NumberOption(spec("supervisor.wipLimit", 4, "repo"), { min: 1 }),
    new BooleanOption({ ...spec("issues.requireConsent", true, "repo"), fixed: true }),
    new KeybindingOption(spec("keys.zoom", ["prefix+z"])),
  ];

  test("the last valid layer wins: user for user options, repo then run for repo options; the default otherwise", () => {
    const { options, diagnostics } = resolveOptions(defs, [
      {
        scope: "user",
        source: "options.yml",
        values: { "ui.paneBorders": "always", "keys.zoom": "prefix+f" },
      },
      { scope: "repo", source: "metator.config.yml", values: { "supervisor.wipLimit": 2 } },
      { scope: "run", source: "r/state.json", values: { "supervisor.wipLimit": 1 } },
    ]);
    const by = Object.fromEntries(options.map((o) => [o.key, o]));
    expect(by["ui.paneBorders"]).toMatchObject({
      value: "always",
      source: "user",
      layers: { user: "always" },
    });
    expect(by["supervisor.wipLimit"]).toMatchObject({ value: 1, source: "run", layers: { repo: 2, run: 1 } });
    expect(by["keys.zoom"]).toMatchObject({ value: ["prefix+f"], source: "user" });
    expect(by["issues.requireConsent"]).toMatchObject({ value: true, source: "default" });
    expect(diagnostics).toEqual([]);
    expect(options.map((o) => o.key)).toEqual([
      "issues.requireConsent",
      "keys.zoom",
      "supervisor.wipLimit",
      "ui.paneBorders",
    ]);
  });

  test("a wrong value, a wrong scope, an unknown key and a fixed option are diagnostics; the default applies", () => {
    const { options, diagnostics } = resolveOptions(defs, [
      {
        scope: "user",
        source: "options.yml",
        values: {
          "ui.paneBorders": "sometimes",
          "supervisor.wipLimit": 9,
          "ui.nope": 1,
          "keys.zoom": "ctrl+",
        },
      },
      { scope: "repo", source: "metator.config.yml", values: { "issues.requireConsent": false } },
    ]);
    const by = Object.fromEntries(options.map((o) => [o.key, o]));
    expect(by["ui.paneBorders"]).toMatchObject({ value: "auto", source: "default" });
    expect(by["supervisor.wipLimit"]).toMatchObject({ value: 4, source: "default" });
    expect(by["keys.zoom"]).toMatchObject({ value: ["prefix+z"], source: "default" });
    expect(by["issues.requireConsent"]).toMatchObject({ value: true });
    expect(diagnostics.map((d) => [d.kind, d.key, d.scope])).toEqual([
      ["invalid-value", "ui.paneBorders", "user"],
      ["wrong-scope", "supervisor.wipLimit", "user"],
      ["fixed", "issues.requireConsent", "repo"],
      ["invalid-value", "keys.zoom", "user"],
      ["unknown-key", "ui.nope", "user"],
    ]);
    expect(diagnostics[0]?.message).toContain("the default applies");
  });

  test("a legacy config field sets a repo option until the options map overrides it; experimental flags exist when named", () => {
    const d = [
      new NumberOption({
        ...spec("supervisor.wipLimit", 4, "repo"),
        legacy: (c: MetatorConfig) => c.supervisor.wipLimit,
      }),
    ];
    const config = MetatorConfigSchema.parse({ supervisor: { wipLimit: 7 } });
    expect(resolveOptions(d, [], config).options[0]).toMatchObject({ value: 7, source: "repo" });
    expect(resolveOptions(d, [], DEFAULT_CONFIG).options[0]).toMatchObject({ value: 4, source: "repo" });
    expect(
      resolveOptions(d, [{ scope: "repo", source: "c", values: { "supervisor.wipLimit": 2 } }], config)
        .options[0],
    ).toMatchObject({ value: 2, source: "repo", layers: { repo: 2 } });
    const flags = resolveOptions([], [{ scope: "user", source: "o", values: { "experimental.tree": true } }]);
    expect(flags.options).toHaveLength(1);
    expect(flags.options[0]).toMatchObject({ key: "experimental.tree", value: true, source: "user" });
    expect(flags.diagnostics).toEqual([]);
  });

  test("UserOptions v1 holds any keys; the per-key check happens on resolve", () => {
    const parsed = UserOptionsDocument.parse(
      { kind: "UserOptions", schemaVersion: 1, options: { "ui.paneBorders": "always", "x.y": 1 } },
      "options.yml",
    );
    expect(parsed._unsafeUnwrap().options).toEqual({ "ui.paneBorders": "always", "x.y": 1 });
    expect(UserOptionsDocument.parse({ kind: "UserOptions", schemaVersion: 1, other: 1 }, "o").isErr()).toBe(
      true,
    );
  });
});
