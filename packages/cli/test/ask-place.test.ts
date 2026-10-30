import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderPlace } from "../src/ask-place.ts";

const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

describe("folderPlace", () => {
  test("a repository linked into the folder is named with where it really is, and may be read there", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "metator-place-")));
    made.push(base);
    const folder = join(base, "folder");
    const elsewhere = join(base, "clones", "api");
    await mkdir(join(folder, "web"), { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, join(folder, "api"));
    const place = folderPlace(
      {
        root: folder,
        repos: [
          { name: "api", path: "api", root: join(folder, "api") },
          { name: "web", path: "web", root: join(folder, "web") },
        ],
        file: null,
      },
      {} as never,
    );
    expect(place.where).toBe(
      `the folder ${folder}, which holds the repositories api (api, a link to ${elsewhere}), web (web)`,
    );
    expect(place.dirs).toEqual([elsewhere]);
  });
});
