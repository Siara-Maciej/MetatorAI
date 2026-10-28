import { afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineStateContract } from "@metator/testing";
import { BunMachineState } from "../src/bun-machine-state.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

machineStateContract("BunMachineState", async () => {
  const dir = await mkdtemp(join(tmpdir(), "metator-state-"));
  dirs.push(dir);
  // The state directory itself is created on the first write.
  return { state: new BunMachineState(join(dir, "state")), existing: dir, missing: join(dir, "gone") };
});
