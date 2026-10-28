import { describe, expect, test } from "bun:test";
import type { MachineState } from "@metator/core";

export interface MachineStateWorld {
  readonly state: MachineState;
  /** An absolute directory that exists, and one that does not. */
  readonly existing: string;
  readonly missing: string;
}

/** Every MachineState adapter must pass this suite (the factory gives an empty state). */
export function machineStateContract(name: string, make: () => Promise<MachineStateWorld>): void {
  describe(`MachineState contract: ${name}`, () => {
    test("a document never written reads as undefined; a written one reads back, overwritten whole", async () => {
      const { state } = await make();
      expect((await state.read("port-leases.json"))._unsafeUnwrap()).toBeUndefined();
      expect((await state.write("port-leases.json", '{"a":1}')).isOk()).toBe(true);
      await state.write("port-leases.json", '{"b":2}');
      expect((await state.read("port-leases.json"))._unsafeUnwrap()).toBe('{"b":2}');
    });

    test("dirExists tells existing directories from missing ones", async () => {
      const w = await make();
      expect([await w.state.dirExists(w.existing), await w.state.dirExists(w.missing)]).toEqual([
        true,
        false,
      ]);
    });
  });
}
