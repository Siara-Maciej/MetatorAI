import { describe, expect, test } from "bun:test";
import type { DataIsolator, PostgresTarget } from "@metator/core";

export interface DataIsolatorWorld {
  readonly isolator: DataIsolator;
  readonly target: PostgresTarget;
  /** Puts one row into a database the suite created, and reads the rows back. */
  readonly insert: (database: string, value: number) => Promise<void>;
  readonly rows: (database: string) => Promise<readonly number[]>;
}

/** Every DataIsolator adapter must pass this suite; `make` gives a fresh server (or fresh names). */
export function dataIsolatorContract(name: string, make: () => Promise<DataIsolatorWorld>): void {
  describe(`DataIsolator contract: ${name}`, () => {
    test("a clone has the template's data and is independent of it", async () => {
      const w = await make();
      expect((await w.isolator.createDatabase(w.target, "c_seed"))._unsafeUnwrap()).toBe(true);
      await w.insert("c_seed", 42);
      expect((await w.isolator.createDatabase(w.target, "c_one", "c_seed"))._unsafeUnwrap()).toBe(true);
      expect((await w.isolator.createDatabase(w.target, "c_two", "c_seed"))._unsafeUnwrap()).toBe(true);
      await w.insert("c_one", 7);
      expect([await w.rows("c_one"), await w.rows("c_two")]).toEqual([[42, 7], [42]]);
      for (const db of ["c_one", "c_two", "c_seed"]) await w.isolator.dropDatabase(w.target, db);
    });

    test("creating twice and dropping twice are not errors; a missing template is", async () => {
      const w = await make();
      expect((await w.isolator.createDatabase(w.target, "c_once"))._unsafeUnwrap()).toBe(true);
      expect((await w.isolator.createDatabase(w.target, "c_once"))._unsafeUnwrap()).toBe(false);
      expect((await w.isolator.dropDatabase(w.target, "c_once"))._unsafeUnwrap()).toBe(true);
      expect((await w.isolator.dropDatabase(w.target, "c_once"))._unsafeUnwrap()).toBe(false);
      const missing = await w.isolator.createDatabase(w.target, "c_x", "c_no_such_template");
      expect(missing._unsafeUnwrapErr().code).toBe("COMMAND_FAILED");
    });
  });
}
