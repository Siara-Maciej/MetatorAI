import { expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { parse } from "yaml";
import { UpdateConfig } from "../src/application/config-edit.ts";
import { editRepoConfig, locateRepoConfig, parseRepoConfig } from "../src/application/config-file.ts";
import { MetatorConfigDocument } from "../src/domain/config.ts";

const V = MetatorConfigDocument.current;

test("the repository's config is the first config file that exists; none is undefined", async () => {
  expect(await locateRepoConfig(new InMemoryFileSystem())).toBeUndefined();
  const both = new InMemoryFileSystem({ "metator.config.json": "{}", "metator.config.yaml": "" });
  expect(await locateRepoConfig(both)).toBe("metator.config.yaml");
});

test("without a config a small one is created under the comment, with the fields set", async () => {
  const fs = new InMemoryFileSystem();
  const saved = await editRepoConfig(fs, [{ path: ["hosts", "targets"], value: ["claude"] }], "Why.");
  expect(saved._unsafeUnwrap()).toEqual({ file: "metator.config.yml" });
  expect((await fs.read("metator.config.yml"))._unsafeUnwrap()).toBe(
    `# Why.\nkind: MetatorConfig\nschemaVersion: ${V}\nhosts:\n  targets:\n    - claude\n`,
  );
  // A field removed from a config that never held it leaves its map, empty.
  const empty = new InMemoryFileSystem();
  await editRepoConfig(empty, [{ path: ["options", "ui.theme"], value: undefined }], "Why.");
  expect(parse((await empty.read("metator.config.yml"))._unsafeUnwrap()).options).toEqual({});
});

test("a YAML config keeps its comments; a JSON one its other fields; a field is set or removed", async () => {
  const yaml = new InMemoryFileSystem({
    "metator.config.yml": `# ours\nkind: MetatorConfig\nschemaVersion: ${V}\neditor: code # mine\n`,
  });
  await editRepoConfig(yaml, [{ path: ["editor"], value: "zed" }], "unused");
  expect((await yaml.read("metator.config.yml"))._unsafeUnwrap()).toBe(
    `# ours\nkind: MetatorConfig\nschemaVersion: ${V}\neditor: zed # mine\n`,
  );
  const json = new InMemoryFileSystem({
    "metator.config.json": `{"kind":"MetatorConfig","schemaVersion":${V},"editor":"code","options":{"a.b":1}}`,
  });
  await editRepoConfig(
    json,
    [
      { path: ["options", "a.b"], value: undefined },
      { path: ["hosts", "targets"], value: ["copilot"] },
    ],
    "unused",
  );
  expect(JSON.parse((await json.read("metator.config.json"))._unsafeUnwrap())).toEqual({
    kind: "MetatorConfig",
    schemaVersion: V,
    editor: "code",
    options: {},
    hosts: { targets: ["copilot"] },
  });
});

test("a change that leaves an invalid config is refused and nothing is written", async () => {
  const before = `kind: MetatorConfig\nschemaVersion: ${V}\n`;
  const fs = new InMemoryFileSystem({ "metator.config.yml": before });
  const refused = await editRepoConfig(fs, [{ path: ["editor"], value: 5 }], "unused");
  expect(refused.isErr()).toBe(true);
  expect((await fs.read("metator.config.yml"))._unsafeUnwrap()).toBe(before);
  expect(parseRepoConfig("{", "metator.config.json").isErr()).toBe(true);
});

test("saving a setting into a config that is not valid as it is changes nothing, even when it would fix it", async () => {
  const before = `kind: MetatorConfig\nschemaVersion: ${V}\neditor: 5\n`;
  const fs = new InMemoryFileSystem({ "metator.config.yml": before });
  expect((await new UpdateConfig(fs).execute({ editor: "zed" })).isErr()).toBe(true);
  expect((await fs.read("metator.config.yml"))._unsafeUnwrap()).toBe(before);
});
