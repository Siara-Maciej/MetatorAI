import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type CanonSource, DEFAULT_PATHS } from "@metator/core";
import { BunFileSystem } from "@metator/plugin-bun";
import pkg from "../package.json" with { type: "json" };

/**
 * The MetatorAI installation this runtime belongs to: the checkout (packages/runtime/src → root)
 * or the npm package (bin/metator.js → its root), whichever has the agents beside it.
 */
const SHIPPED = [resolve(import.meta.dir, "../../.."), resolve(import.meta.dir, "..")];

/**
 * Where `agents install|update` copy the canon from: METATOR_CANON when set, otherwise the
 * installation itself. Null when that directory has no agents (an incomplete installation).
 */
export function resolveCanon(dir: string | undefined): CanonSource | null {
  const candidates = dir ? [resolve(dir)] : SHIPPED;
  const location = candidates.find((c) => existsSync(resolve(c, DEFAULT_PATHS.agents)));
  if (!location) return null;
  return { files: new BunFileSystem(location), location, version: pkg.version };
}
