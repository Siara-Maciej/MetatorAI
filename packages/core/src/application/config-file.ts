import {
  CONFIG_FILES,
  type MetatorConfig,
  MetatorConfigDocument,
  RETIRED_CONFIG_KEYS,
  withoutLocalStatePaths,
} from "../domain/config.ts";
import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  deleteYamlPaths,
  parseJsonDocument,
  renderYamlDocument,
  serializeJsonDocument,
  updateYamlPath,
} from "../domain/versioned.ts";
import type { FileSystem, ReadonlyFileSystem } from "../ports/index.ts";
import { parseDocumentText } from "./document-io.ts";

/** The config a new repository gets when a setting is saved before any config exists. */
export const NEW_CONFIG_FILE = "metator.config.yml";

/** One setting of metator.config: the field at `path`, set to `value` or removed when undefined. */
export interface ConfigFieldChange {
  readonly path: readonly string[];
  readonly value: unknown;
}

/** The repository's config file: the first of `CONFIG_FILES` that exists. */
export async function locateRepoConfig(fs: Pick<ReadonlyFileSystem, "exists">): Promise<string | undefined> {
  for (const file of CONFIG_FILES) if (await fs.exists(file)) return file;
  return undefined;
}

/** The config's text as a validated config (YAML, or JSON for `.json`). */
export function parseRepoConfig(text: string, file: string): Result<MetatorConfig, MetatorError> {
  return parseDocumentText(text, file, MetatorConfigDocument, file.endsWith(".json") ? "json" : "yaml");
}

/**
 * Changes settings in metator.config. A YAML file keeps its comments and its other settings; the
 * file is written at the current version, without the keys that version dropped (v12: the local
 * state under `paths`); without a config, a small one is created under `comment`. The result is
 * validated before it is written.
 */
export async function editRepoConfig(
  fs: FileSystem,
  changes: readonly ConfigFieldChange[],
  comment: string,
): Promise<Result<{ readonly file: string }, MetatorError>> {
  const version: ConfigFieldChange = { path: ["schemaVersion"], value: MetatorConfigDocument.current };
  const file = await locateRepoConfig(fs);
  let next: string;
  if (!file) {
    const doc: Record<string, unknown> = { kind: MetatorConfigDocument.kind };
    for (const change of [version, ...changes]) setIn(doc, change.path, change.value);
    next = renderYamlDocument(doc as { kind: string; schemaVersion: number }, comment);
  } else {
    const text = await fs.read(file);
    if (text.isErr()) return err(text.error);
    if (file.endsWith(".json")) {
      const raw = parseJsonDocument(text.value, file);
      if (raw.isErr()) return err(raw.error);
      const doc = copy(withoutLocalStatePaths(raw.value) as Record<string, unknown>);
      for (const change of [version, ...changes]) setIn(doc, change.path, change.value);
      next = serializeJsonDocument(doc);
    } else {
      next = text.value;
      for (const change of [version, ...changes]) next = updateYamlPath(next, change.path, change.value);
      next = deleteYamlPaths(next, RETIRED_CONFIG_KEYS);
    }
  }
  // The file must be a valid config before it is written.
  const target = file ?? NEW_CONFIG_FILE;
  const valid = parseRepoConfig(next, target);
  if (valid.isErr()) return err(valid.error);
  const saved = await fs.write(target, next);
  return saved.isErr() ? err(saved.error) : ok({ file: target });
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A copy whose maps can be changed without touching the value they came from. */
function copy(map: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, isMap(v) ? copy(v) : v]));
}

/** Sets or removes the field at the path, creating the maps on the way (a non-map in the way is replaced). */
function setIn(map: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    if (value === undefined) delete map[head];
    else map[head] = value;
    return;
  }
  if (!isMap(map[head])) map[head] = {};
  setIn(map[head] as Record<string, unknown>, rest, value);
}
