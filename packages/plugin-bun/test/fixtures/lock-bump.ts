/** One process of the lock test: adds one to a counter file, fifteen times, each under the lock. */
import { ok } from "@metator/core";
import { BunFileLock } from "../../src/bun-file-lock.ts";

const root = process.argv[2] as string;
const lock = new BunFileLock(root);
for (let i = 0; i < 15; i++) {
  const r = await lock.hold("counter.txt", async () => {
    const file = Bun.file(`${root}/counter.txt`);
    const n = (await file.exists()) ? Number(await file.text()) : 0;
    await Bun.write(`${root}/counter.txt`, String(n + 1));
    return ok(undefined);
  });
  if (r.isErr()) {
    console.error(r.error.message);
    process.exit(1);
  }
}
