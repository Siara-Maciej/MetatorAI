import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_WORLD, standInContainerCli } from "@metator/testing";
import { bundleIn, devContainers } from "../src/devcontainers.ts";

const scratch = mkdtempSync(join(tmpdir(), "metator-rt-dc-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const manifest = (arch: string) => ({
  kind: "LinuxCliBundle",
  schemaVersion: 1,
  version: "0.5.0",
  platform: "linux",
  libc: "glibc",
  glibc: "2.31",
  arch,
  tarball: `metator-linux-${arch}.tar.gz`,
  entry: `metator-linux-${arch}/bin/metator`,
  sha256: "abc",
});

describe("the bundles folder", () => {
  test("a bundle is read from its architecture's manifest, its tarball beside it", () => {
    const dir = join(scratch, "bundles");
    mkdirSync(join(dir, "x64"), { recursive: true });
    writeFileSync(join(dir, "x64", "metator-bundle.json"), JSON.stringify(manifest("x64")));
    expect(bundleIn(dir, "x64")._unsafeUnwrapErr().message).toContain("tarball is not there");
    writeFileSync(join(dir, "x64", "metator-linux-x64.tar.gz"), "tar");
    expect(bundleIn(dir, "x64")._unsafeUnwrap().tarball).toBe(join(dir, "x64", "metator-linux-x64.tar.gz"));
    expect(bundleIn(dir, "arm64")._unsafeUnwrapErr().code).toBe("NOT_FOUND");
    expect(bundleIn(undefined, "x64")._unsafeUnwrapErr().hint).toContain("--bundles");
    mkdirSync(join(dir, "arm64"));
    writeFileSync(join(dir, "arm64", "metator-bundle.json"), "{");
    expect(bundleIn(dir, "arm64")._unsafeUnwrapErr().code).toBe("INVALID_ARTIFACT");
  });
});

describe("the engine found on PATH", () => {
  test("docker when it answers, else nerdctl; none says why", async () => {
    const both = join(scratch, "both");
    standInContainerCli(both, "docker", { containers: [] });
    standInContainerCli(both, "nerdctl", CONTAINER_WORLD);
    const dc = await devContainers({ env: { PATH: both }, bundles: undefined });
    expect(dc.engineInfo()._unsafeUnwrap()).toMatchObject({
      program: "nerdctl",
      path: join(both, "nerdctl"),
    });
    expect((await dc.list())._unsafeUnwrap().containers.map((c) => c.name)).toEqual(["api-dev", "shop-dev"]);

    const none = await devContainers({ env: { PATH: join(scratch, "empty") }, bundles: undefined });
    expect((await none.list())._unsafeUnwrap().problem).toContain("Neither docker nor nerdctl");

    const named = join(scratch, "named");
    const program = standInContainerCli(named, "docker", CONTAINER_WORLD);
    const chosen = await devContainers({
      env: { PATH: both, METATOR_DOCKER_BIN: program },
      bundles: undefined,
    });
    expect(chosen.engineInfo()._unsafeUnwrap()).toMatchObject({
      program: "docker",
      path: program,
      context: "rancher-desktop",
    });
  });
});
