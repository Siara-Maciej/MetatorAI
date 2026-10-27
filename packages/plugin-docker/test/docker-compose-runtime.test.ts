import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerComposeRuntime } from "../src/docker-compose-runtime.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A stand-in `docker`: appends its argv and one variable to a file; fails when asked to. */
async function fakeDocker(code = 0) {
  const dir = await mkdtemp(join(tmpdir(), "metator-docker-"));
  dirs.push(dir);
  const calls = join(dir, "calls");
  const bin = join(dir, "docker");
  await writeFile(
    bin,
    `#!/bin/sh\necho "$* | PORT=$METATOR_PORT_API_HTTP | cwd=$(pwd)" >> ${calls}\necho "db-1  | ready"\necho "boom" >&2\nexit ${code}\n`,
  );
  await chmod(bin, 0o755);
  return { bin, calls, dir };
}

test("up, stop and logs of one service of one project, in its directory, with the ports", async () => {
  const d = await fakeDocker();
  const rt = new DockerComposeRuntime(d.bin);
  const svc = {
    file: "compose.yml",
    service: "api",
    project: "metator-feat",
    cwd: d.dir,
    env: { METATOR_PORT_API_HTTP: "41000" },
  };
  expect((await rt.up(svc)).isOk()).toBe(true);
  expect((await rt.stop(svc)).isOk()).toBe(true);
  expect((await rt.logs(svc, 20))._unsafeUnwrap()).toBe("db-1  | ready\n");
  expect((await Bun.file(d.calls).text()).trim().split("\n")).toEqual([
    `compose -p metator-feat -f compose.yml up -d api | PORT=41000 | cwd=${d.dir}`,
    `compose -p metator-feat -f compose.yml stop api | PORT=41000 | cwd=${d.dir}`,
    `compose -p metator-feat -f compose.yml logs --no-color --tail 20 api | PORT=41000 | cwd=${d.dir}`,
  ]);
});

test("a failing compose is an error value with stderr; a missing binary is BIN_NOT_FOUND", async () => {
  const d = await fakeDocker(1);
  const svc = { file: "compose.yml", service: "db", project: "metator-shared", cwd: d.dir, env: {} };
  expect((await new DockerComposeRuntime(d.bin).up(svc))._unsafeUnwrapErr().message).toContain(
    "exited 1: boom",
  );
  const missing = await new DockerComposeRuntime(join(d.dir, "nope")).up(svc);
  expect(missing._unsafeUnwrapErr().code).toBe("BIN_NOT_FOUND");
});
