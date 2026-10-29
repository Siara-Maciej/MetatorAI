import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { parse } from "yaml";
import { UpdateConfig } from "../src/application/config-edit.ts";
import { MetatorConfigDocument } from "../src/domain/config.ts";
import { editorLaunch, preferredEditor } from "../src/domain/editors.ts";

describe("editors", () => {
  test("GUI editors open on their own; terminal editors take over the terminal; options are kept", () => {
    expect(editorLaunch("code", "/wt")).toEqual({ argv: ["code", "/wt"], attached: false });
    expect(editorLaunch("code --new-window", "/wt")).toEqual({
      argv: ["code", "--new-window", "/wt"],
      attached: false,
    });
    expect(editorLaunch("/usr/bin/nvim", "/wt")).toEqual({ argv: ["/usr/bin/nvim", "/wt"], attached: true });
    expect(editorLaunch("my-editor", "/wt").attached).toBe(false);
  });

  test("the config wins, then $VISUAL, then $EDITOR; empty values count as unset", () => {
    expect(preferredEditor("zed", { VISUAL: "code", EDITOR: "vim" })).toBe("zed");
    expect(preferredEditor(undefined, { VISUAL: "code", EDITOR: "vim" })).toBe("code");
    expect(preferredEditor(undefined, { VISUAL: "", EDITOR: "vim" })).toBe("vim");
    expect(preferredEditor(undefined, { EDITOR: "" })).toBeUndefined();
  });
});

describe("UpdateConfig", () => {
  test("a YAML config keeps its comments and other settings and becomes the current version", async () => {
    const fs = new InMemoryFileSystem({
      "metator.config.yml":
        "# ours\nkind: MetatorConfig\nschemaVersion: 2\nhosts:\n  targets: [claude] # only claude\n",
    });
    expect((await new UpdateConfig(fs).execute({ editor: "cursor" }))._unsafeUnwrap()).toEqual({
      file: "metator.config.yml",
    });
    const text = (await fs.read("metator.config.yml"))._unsafeUnwrap();
    expect(text).toContain("# ours");
    expect(text).toContain("# only claude");
    const config = MetatorConfigDocument.parse(parse(text), "c")._unsafeUnwrap();
    expect([config.editor, config.hosts.targets, parse(text).schemaVersion]).toEqual([
      "cursor",
      ["claude"],
      4,
    ]);
  });

  test("a JSON config, no config at all, and an invalid one", async () => {
    const json = new InMemoryFileSystem({
      "metator.config.json": '{"kind":"MetatorConfig","schemaVersion":1}',
    });
    await new UpdateConfig(json).execute({ editor: "zed" });
    expect(JSON.parse((await json.read("metator.config.json"))._unsafeUnwrap())).toEqual({
      kind: "MetatorConfig",
      schemaVersion: 4,
      editor: "zed",
    });
    const none = new InMemoryFileSystem();
    await new UpdateConfig(none).execute({ editor: "nvim" });
    const created = parse((await none.read("metator.config.yml"))._unsafeUnwrap());
    expect(MetatorConfigDocument.parse(created, "c")._unsafeUnwrap().editor).toBe("nvim");
    const bad = new InMemoryFileSystem({
      "metator.config.yml": "kind: MetatorConfig\nschemaVersion: 2\nnope: 1\n",
    });
    expect((await new UpdateConfig(bad).execute({ editor: "x" }))._unsafeUnwrapErr().code).toBe(
      "INVALID_CONFIG",
    );
  });

  test("host targets are set in place, nested, keeping comments; an invalid host is refused", async () => {
    const fs = new InMemoryFileSystem({
      "metator.config.yml": "kind: MetatorConfig\nschemaVersion: 3\neditor: zed # mine\n",
    });
    await new UpdateConfig(fs).execute({ hostTargets: ["claude", "copilot"] });
    const text = (await fs.read("metator.config.yml"))._unsafeUnwrap();
    expect(text).toContain("# mine");
    expect(parse(text).hosts).toEqual({ targets: ["claude", "copilot"] });
    const before = text;
    const bad = await new UpdateConfig(fs).execute({ hostTargets: ["vim" as never] });
    expect(bad._unsafeUnwrapErr().code).toBe("INVALID_CONFIG");
    expect((await fs.read("metator.config.yml"))._unsafeUnwrap()).toBe(before);
    const json = new InMemoryFileSystem({
      "metator.config.json":
        '{"kind":"MetatorConfig","schemaVersion":3,"hosts":{"metatorCommand":"bun run metator"}}',
    });
    await new UpdateConfig(json).execute({ hostTargets: ["copilot"] });
    expect(JSON.parse((await json.read("metator.config.json"))._unsafeUnwrap()).hosts).toEqual({
      metatorCommand: "bun run metator",
      targets: ["copilot"],
    });
    const none = new InMemoryFileSystem();
    await new UpdateConfig(none).execute({ hostTargets: ["copilot"] });
    expect(parse((await none.read("metator.config.yml"))._unsafeUnwrap()).hosts).toEqual({
      targets: ["copilot"],
    });
  });

  test("every v2 config reads as the current version without an editor", () => {
    const v2 = MetatorConfigDocument.parse(
      { kind: "MetatorConfig", schemaVersion: 2, hosts: { targets: ["copilot"] } },
      "c",
    );
    expect([v2._unsafeUnwrap().editor, MetatorConfigDocument.current]).toEqual([undefined, 4]);
  });
});
