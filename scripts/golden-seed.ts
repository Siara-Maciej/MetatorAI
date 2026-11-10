/**
 * Writes the golden set from what this repository knows (F3): the unit suite's mutants become
 * seeded cases, the commits later fixes repaired become bug cases, ordinary commits clean cases.
 * `bun run golden:seed`; the cases land in docs/metator/evals/golden/.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MUTANTS } from "./mutants.ts";

const dir = await mkdtemp(join(tmpdir(), "metator-golden-"));
const file = join(dir, "mutants.json");
await Bun.write(file, JSON.stringify(MUTANTS));
const args = process.argv.slice(2);
const proc = Bun.spawn(
  ["bun", join(import.meta.dir, "../packages/cli/src/main.ts"), "eval", "seed", "--mutants", file, ...args],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
const code = await proc.exited;
await rm(dir, { recursive: true, force: true });
process.exit(code);
