import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunCheckoutReader } from "../src/bun-checkout-reader.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

test("reads a checkout's file, undefined when absent, and never outside its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "metator-checkout-"));
  dirs.push(root);
  await mkdir(join(root, "svc"));
  await writeFile(join(root, "svc", "openapi.yaml"), "openapi: 3.0.0\n");
  const reader = new BunCheckoutReader();
  expect((await reader.read(root, "svc/openapi.yaml"))._unsafeUnwrap()).toBe("openapi: 3.0.0\n");
  expect((await reader.read(root, "./svc/../svc/openapi.yaml"))._unsafeUnwrap()).toBe("openapi: 3.0.0\n");
  expect((await reader.read(root, "missing.yaml"))._unsafeUnwrap()).toBeUndefined();
  expect((await reader.read(join(root, "svc"), "../outside.yaml"))._unsafeUnwrapErr().code).toBe("USAGE");
  expect([
    await reader.isDirectory(join(root, "svc")),
    await reader.isDirectory(join(root, "svc", "openapi.yaml")),
    await reader.isDirectory(join(root, "absent")),
  ]).toEqual([true, false, false]);
});
