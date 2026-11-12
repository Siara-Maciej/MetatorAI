import { describe, expect, test } from "bun:test";
import { err, type FileLock, MetatorError, ok } from "@metator/core";

/** Every FileLock adapter must pass this suite (the factory gives a lock nobody holds). */
export function fileLockContract(name: string, make: () => Promise<FileLock>): void {
  describe(`FileLock contract: ${name}`, () => {
    test("hold returns what the work returned, an error value included, and releases the lock", async () => {
      const lock = await make();
      expect((await lock.hold("state/a.json", async () => ok(7)))._unsafeUnwrap()).toBe(7);
      const failed = await lock.hold("state/a.json", async () => err(MetatorError.usage("no")));
      expect(failed._unsafeUnwrapErr().message).toBe("no");
      expect((await lock.hold("state/a.json", async () => ok("again")))._unsafeUnwrap()).toBe("again");
    });

    test("holders of one path never overlap: a read-modify-write under the lock loses nothing", async () => {
      const lock = await make();
      let value = 0;
      let inside = 0;
      let overlapped = false;
      const bump = () =>
        lock.hold("state/counter.json", async () => {
          inside++;
          if (inside > 1) overlapped = true;
          const read = value;
          await Bun.sleep(2);
          value = read + 1;
          inside--;
          return ok(undefined);
        });
      const results = await Promise.all(Array.from({ length: 12 }, bump));
      expect(results.every((r) => r.isOk())).toBe(true);
      expect([value, overlapped]).toEqual([12, false]);
    });

    test("locks of different paths do not wait for each other", async () => {
      const lock = await make();
      const order: string[] = [];
      let releaseA: () => void = () => {};
      const a = lock.hold("state/a.json", async () => {
        await new Promise<void>((resolve) => {
          releaseA = resolve;
        });
        order.push("a");
        return ok(undefined);
      });
      await lock.hold("state/b.json", async () => {
        order.push("b");
        return ok(undefined);
      });
      releaseA();
      await a;
      expect(order).toEqual(["b", "a"]);
    });

    test("work that throws still releases the lock", async () => {
      const lock = await make();
      const thrown = await lock
        .hold("state/a.json", async () => {
          throw new Error("boom");
        })
        .catch((e: Error) => e.message);
      expect(thrown).toBe("boom");
      expect((await lock.hold("state/a.json", async () => ok(1)))._unsafeUnwrap()).toBe(1);
    });
  });
}
