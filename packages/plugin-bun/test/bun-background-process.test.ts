import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunBackgroundProcess, BunTimer } from "../src/bun-background-process.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

test("a background process runs on its own, writes its log and stops on request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "metator-bg-"));
  dirs.push(dir);
  const bg = new BunBackgroundProcess();
  const log = join(dir, "logs/drive.log");
  const pid = (await bg.start(["sh", "-c", "echo started; sleep 30"], dir, log))._unsafeUnwrap();
  expect(bg.isAlive(pid)).toBe(true);
  for (let i = 0; i < 50 && !(await Bun.file(log).text()).includes("started"); i++)
    await new BunTimer().sleep(20);
  expect(await Bun.file(log).text()).toContain("started");
  expect((await bg.stop(pid)).isOk()).toBe(true);
  expect(bg.isAlive(pid)).toBe(false);
  expect((await bg.stop(pid)).isOk()).toBe(true);
});

test("a binary that cannot start is an error value", async () => {
  const r = await new BunBackgroundProcess().start(
    ["metator-definitely-missing-binary"],
    tmpdir(),
    join(tmpdir(), "x.log"),
  );
  expect(r._unsafeUnwrapErr().code).toBe("COMMAND_FAILED");
});

test("a background process gets its environment; its log can be read back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "metator-bg-"));
  dirs.push(dir);
  const bg = new BunBackgroundProcess();
  const log = join(dir, "svc.log");
  const pid = (
    await bg.start(["sh", "-c", 'echo "port=$PORT"; echo second'], dir, log, { PORT: "41000" })
  )._unsafeUnwrap();
  for (let i = 0; i < 50 && bg.isAlive(pid); i++) await new BunTimer().sleep(20);
  expect(await bg.readLog(log, 1)).toBe("second");
  expect(await bg.readLog(log, 5)).toBe("port=41000\nsecond");
  expect(await bg.readLog(join(dir, "none.log"), 5)).toBe("");
});
