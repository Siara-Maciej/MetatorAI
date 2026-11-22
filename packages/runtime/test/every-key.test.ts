import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** The fields of the `Cradle` interface, read from its source (a type leaves nothing at run time). */
async function cradleFields(): Promise<string[]> {
  const text = await Bun.file(join(import.meta.dir, "../src/container.ts")).text();
  const body = text.slice(text.indexOf("export interface Cradle {"));
  const fields: string[] = [];
  let depth = 0;
  for (const line of body.split("\n").slice(1)) {
    if (depth === 0 && line.startsWith("}")) break;
    const field = depth === 0 ? /^ {2}(\w+)\??:/.exec(line)?.[1] : undefined;
    if (field) fields.push(field);
    depth += (line.match(/[{(]/g)?.length ?? 0) - (line.match(/[})]/g)?.length ?? 0);
  }
  return fields;
}

async function container(extra: Parameters<typeof bootstrap>[0] | object = {}) {
  const root = await mkdtemp(join(tmpdir(), "metator-keys-"));
  dirs.push(root);
  return bootstrap({
    root,
    stateDir: join(root, ".state"),
    userConfigDir: join(root, ".user"),
    ...extra,
  });
}

describe("the container of a repository", () => {
  test("every registered key resolves: nothing a use case is given is missing", async () => {
    const c = await container();
    const keys = Object.keys(c.registrations);
    expect(keys.length).toBeGreaterThan(200);
    const broken: string[] = [];
    for (const key of keys) {
      try {
        c.resolve(key);
      } catch (e) {
        broken.push(`${key}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("with a scenario host played, every key still resolves", async () => {
    const c = await container({ agentScenario: "/nowhere/scenario.yml" });
    for (const key of Object.keys(c.registrations)) expect(() => c.resolve(key)).not.toThrow();
    expect([...c.resolve("interactiveHosts").keys()][0]).toBe("scenario");
  });

  test("the Cradle type and the registrations name the same keys", async () => {
    const c = await container();
    const registered = Object.keys(c.registrations).sort();
    const typed = (await cradleFields()).sort();
    expect(typed.length).toBeGreaterThan(200);
    expect(registered.filter((k) => !typed.includes(k))).toEqual([]);
    expect(typed.filter((k) => !registered.includes(k))).toEqual([]);
  });
});
