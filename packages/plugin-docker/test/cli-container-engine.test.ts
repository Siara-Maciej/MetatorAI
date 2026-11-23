import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_WORLD, containerEngineContract, standInContainerCli } from "@metator/testing";
import {
  DockerCliEngine,
  engineFacts,
  metadataOf,
  NerdctlCliEngine,
  readDetails,
} from "../src/cli-container-engine.ts";

const scratch = mkdtempSync(join(tmpdir(), "metator-engines-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const dir = () => join(scratch, String(++n));

containerEngineContract(
  "DockerCliEngine",
  (world) => new DockerCliEngine(standInContainerCli(dir(), "docker", world)),
);
containerEngineContract(
  "NerdctlCliEngine",
  (world) => new NerdctlCliEngine(standInContainerCli(dir(), "nerdctl", world)),
);

describe("the CLI engines", () => {
  test("a program that is not there is BIN_NOT_FOUND, and a failing one says what it said", async () => {
    const missing = await new DockerCliEngine(join(scratch, "no-docker")).list("x");
    expect(missing._unsafeUnwrapErr().code).toBe("BIN_NOT_FOUND");
    const engine = new DockerCliEngine(standInContainerCli(dir(), "docker", CONTAINER_WORLD));
    const e = (await engine.inspect(["nope"]))._unsafeUnwrapErr();
    expect(e.message).toBe("`docker inspect nope` exited 1: Error: No such object: nope");
    expect((await engine.inspect([]))._unsafeUnwrap()).toEqual([]);
  });

  test("a stopped container refuses exec as the engine does", async () => {
    const engine = new NerdctlCliEngine(standInContainerCli(dir(), "nerdctl", CONTAINER_WORLD));
    const r = (await engine.exec("bbb222", { user: "root", argv: ["true"] }))._unsafeUnwrap();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("is not running");
  });

  test("inspect is read in docker's shape and nerdctl's; the metadata label is a list of objects", () => {
    expect(
      readDetails({
        Id: "x",
        Name: "/n",
        Image: "sha256:1",
        State: { Running: true },
        Config: { Image: "img" },
      }),
    ).toEqual({
      id: "x",
      name: "n",
      image: "img",
      state: "running",
      user: "",
      labels: {},
      env: [],
      mounts: [],
      metadata: [],
    });
    expect(
      readDetails({ Id: "y", Name: "m", Image: "img2", State: {}, Labels: { a: "1", b: 2 } }),
    ).toMatchObject({
      name: "m",
      image: "img2",
      state: "exited",
      labels: { a: "1" },
    });
    expect(readDetails(null).id).toBe("");
    expect(metadataOf('{"remoteUser":"a"}')).toEqual([{ remoteUser: "a" }]);
    expect(metadataOf('[{"a":1}, 2, null, [3]]')).toEqual([{ a: 1 }]);
    expect([metadataOf("nope"), metadataOf(undefined)]).toEqual([[], []]);
  });

  test("the facts of an engine: where, its version and docker's context; why it does not answer", async () => {
    const up = standInContainerCli(dir(), "docker", { ...CONTAINER_WORLD, context: "desktop-linux" });
    expect(await engineFacts("docker", () => up)).toEqual({
      program: "docker",
      path: up,
      version: "27.3.1",
      context: "desktop-linux",
      said: "",
    });
    const nerd = standInContainerCli(dir(), "nerdctl", CONTAINER_WORLD);
    expect((await engineFacts("nerdctl", () => nerd)).context).toBeNull();
    const down = standInContainerCli(dir(), "docker", { containers: [] });
    expect(await engineFacts("docker", () => down)).toEqual({
      program: "docker",
      path: down,
      version: null,
      context: null,
      said: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    });
    expect(await engineFacts("nerdctl", () => null)).toEqual({
      program: "nerdctl",
      path: null,
      version: null,
      context: null,
      said: "",
    });
    // A client that prints something and still fails (its server is down) has no version.
    const half = join(dir(), "docker");
    mkdirSync(join(half, ".."), { recursive: true });
    writeFileSync(half, "#!/bin/sh\necho 27.3.1\necho 'error during connect' >&2\nexit 1\n");
    chmodSync(half, 0o755);
    expect(await engineFacts("docker", () => half)).toMatchObject({
      version: null,
      said: "error during connect",
    });
    const gone = await engineFacts("docker", () => join(scratch, "vanished"));
    expect([gone.version, gone.said === ""]).toEqual([null, false]);
  });
});
