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

test("stop ends what the command started too, not only the shell around it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "metator-bg-"));
  dirs.push(dir);
  const bg = new BunBackgroundProcess();
  const log = join(dir, "svc.log");
  // The shell starts a child and waits for it, as `sh -c "bun server.ts && …"` does.
  const pid = (
    await bg.start(["sh", "-c", "sleep 30 & echo $! > child.pid; wait"], dir, log)
  )._unsafeUnwrap();
  const childPid = async () => {
    const f = Bun.file(join(dir, "child.pid")); // fresh each time: the file appears later
    return (await f.exists()) ? Number((await f.text()).trim()) : 0;
  };
  for (let i = 0; i < 100 && !(await childPid()); i++) await new BunTimer().sleep(20);
  const child = await childPid();
  // Alive and not a zombie (an exited child nobody reaped, as under a container without init).
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
    } catch {
      return false;
    }
    const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(p)])
      .stdout.toString()
      .trim();
    return stat !== "" && !stat.startsWith("Z");
  };
  expect(alive(child)).toBe(true);
  expect((await bg.stop(pid)).isOk()).toBe(true);
  for (let i = 0; i < 50 && alive(child); i++) await new BunTimer().sleep(20);
  expect(alive(child)).toBe(false);
});

test("a service started by a CLI that already exited is dead once stopped, even as an unreaped zombie", async () => {
  const dir = await mkdtemp(join(tmpdir(), "metator-bg-"));
  dirs.push(dir);
  // Like `metator env up`: the starting process exits, so the service's shell is an orphan.
  const starter = [
    `import { BunBackgroundProcess } from ${JSON.stringify(join(import.meta.dir, "../src/bun-background-process.ts"))};`,
    `const r = await new BunBackgroundProcess().start(["sh", "-c", "sleep 30"], ${JSON.stringify(dir)}, ${JSON.stringify(join(dir, "svc.log"))});`,
    "console.log(r._unsafeUnwrap());",
  ].join("\n");
  await Bun.write(join(dir, "start.ts"), starter);
  const out = Bun.spawnSync(["bun", join(dir, "start.ts")]);
  const pid = Number(out.stdout.toString().trim());
  const bg = new BunBackgroundProcess();
  expect(bg.isAlive(pid)).toBe(true);
  expect((await bg.stop(pid)).isOk()).toBe(true);
  // Without an init that reaps orphans, the shell lingers as a zombie: that is not alive.
  expect(bg.isAlive(pid)).toBe(false);
});
