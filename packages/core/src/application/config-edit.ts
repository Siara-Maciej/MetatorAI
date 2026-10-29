import { CONFIG_FILES, type HostTarget, MetatorConfigDocument } from "../domain/config.ts";
import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  parseJsonDocument,
  parseYamlDocument,
  renderYamlDocument,
  serializeJsonDocument,
  updateYamlFields,
} from "../domain/versioned.ts";
import type { FileSystem } from "../ports/index.ts";

/** The settings `metator ui` changes (ADR-0054, ADR-0060). */
export interface ConfigChanges {
  readonly editor?: string;
  /** Hosts that get agents, skills and hooks; run `metator agents update` after a change. */
  readonly hostTargets?: readonly HostTarget[];
}

/**
 * Saves settings in metator.config. A YAML file keeps its comments and its other settings; the
 * file becomes v3, which every v2 file already is; without a config, a small one is created. The
 * result is validated before it is written.
 */
export class UpdateConfig {
  constructor(private readonly fs: FileSystem) {}

  async execute(changes: ConfigChanges): Promise<Result<{ readonly file: string }, MetatorError>> {
    const fields: Record<string, unknown> = {
      schemaVersion: MetatorConfigDocument.current,
      ...(changes.editor !== undefined ? { editor: changes.editor } : {}),
      ...(changes.hostTargets !== undefined ? { "hosts.targets": [...changes.hostTargets] } : {}),
    };
    let file: string | undefined;
    for (const f of CONFIG_FILES) if (await this.fs.exists(f)) file = file ?? f;
    if (!file) {
      const created = "metator.config.yml";
      const doc = nest({ kind: MetatorConfigDocument.kind, ...fields });
      const valid = MetatorConfigDocument.parse(doc, created);
      if (valid.isErr()) return err(valid.error);
      const text = renderYamlDocument(
        doc as { kind: string; schemaVersion: number } & Record<string, unknown>,
        "Written by `metator ui`; every other setting keeps its default.",
      );
      return (await this.fs.write(created, text)).map(() => ({ file: created }));
    }
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    const json = file.endsWith(".json");
    const current = json ? parseJsonDocument(text.value, file) : parseYamlDocument(text.value, file);
    if (current.isErr()) return err(current.error);
    const valid = MetatorConfigDocument.parse(current.value, file);
    if (valid.isErr()) return err(valid.error);
    const next = json
      ? serializeJsonDocument(merge(current.value as Record<string, unknown>, nest(fields)))
      : updateYamlFields(text.value, fields);
    const after = (json ? parseJsonDocument(next, file) : parseYamlDocument(next, file)).andThen((raw) =>
      MetatorConfigDocument.parse(raw, file),
    );
    if (after.isErr()) return err(after.error);
    const saved = await this.fs.write(file, next);
    if (saved.isErr()) return err(saved.error);
    return ok({ file });
  }
}

/** `{ "hosts.targets": x }` → `{ hosts: { targets: x } }`. */
function nest(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const path = key.split(".");
    let at = out;
    for (const part of path.slice(0, -1)) {
      at[part] ??= {};
      at = at[part] as Record<string, unknown>;
    }
    at[path.at(-1) as string] = value;
  }
  return out;
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)
        ? merge(b as Record<string, unknown>, v as Record<string, unknown>)
        : v;
  }
  return out;
}
