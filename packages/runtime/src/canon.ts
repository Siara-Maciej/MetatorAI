import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type CanonSource, DEFAULT_PATHS } from "@metator/core";
import { BunFileSystem } from "@metator/plugin-bun";
import pkg from "../package.json" with { type: "json" };

/** The MetatorAI checkout or package this runtime belongs to (packages/runtime/src → root). */
const SHIPPED = resolve(import.meta.dir, "../../..");

/**
 * Where `agents install|update` copy the canon from: METATOR_CANON when set, otherwise the
 * installation itself. Null when that directory has no agents (an incomplete installation).
 */
export function resolveCanon(dir: string | undefined): CanonSource | null {
  const location = resolve(dir ?? SHIPPED);
  if (!existsSync(resolve(location, DEFAULT_PATHS.agents))) return null;
  return { files: new BunFileSystem(location), location, version: pkg.version };
}
