import type { HostTarget } from "../domain/config.ts";
import type { MetatorError } from "../domain/errors.ts";
import { err, type Result } from "../domain/result.ts";
import type { FileSystem } from "../ports/index.ts";
import { editRepoConfig, locateRepoConfig, parseRepoConfig } from "./config-file.ts";

/** The settings `metator ui` changes (ADR-0054, ADR-0060). */
export interface ConfigChanges {
  readonly editor?: string;
  /** Hosts that get agents, skills and hooks; run `metator agents update` after a change. */
  readonly hostTargets?: readonly HostTarget[];
}

/**
 * Saves settings in metator.config. A YAML file keeps its comments and its other settings; the
 * file is written at the current version, without the keys that version dropped (v12: the local
 * state under `paths`); without a config, a small one is created. The result is validated before
 * it is written.
 */
export class UpdateConfig {
  constructor(private readonly fs: FileSystem) {}

  async execute(changes: ConfigChanges): Promise<Result<{ readonly file: string }, MetatorError>> {
    // A config that is not valid as it is stays untouched: its error is the answer.
    const file = await locateRepoConfig(this.fs);
    if (file) {
      const text = await this.fs.read(file);
      if (text.isErr()) return err(text.error);
      const current = parseRepoConfig(text.value, file);
      if (current.isErr()) return err(current.error);
    }
    return editRepoConfig(
      this.fs,
      [
        ...(changes.editor !== undefined ? [{ path: ["editor"], value: changes.editor }] : []),
        ...(changes.hostTargets !== undefined
          ? [{ path: ["hosts", "targets"], value: [...changes.hostTargets] }]
          : []),
      ],
      "Written by `metator ui`; every other setting keeps its default.",
    );
  }
}
