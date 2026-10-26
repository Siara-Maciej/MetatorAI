import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FILES,
  DEFAULT_CONFIG,
  DEFAULT_PATHS,
  err,
  type MetatorConfig,
  MetatorConfigDocument,
  type MetatorError,
  type MetatorPaths,
  ok,
  parseYamlDocument,
  type Result,
} from "@metator/core";

export interface LoadedConfig {
  readonly config: MetatorConfig;
  /** Repo-relative config file, or undefined when the repository has none. */
  readonly source: string | undefined;
}

/**
 * Reads the repository's config once, at the composition root (YAML parses JSON too).
 * A missing file is not an error; an invalid one is, with the exact field.
 */
export function loadConfig(root: string): Result<LoadedConfig, MetatorError> {
  for (const file of CONFIG_FILES) {
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseYamlDocument(text, file).andThen((raw) => MetatorConfigDocument.parse(raw, file));
    return parsed.isOk() ? ok({ config: parsed.value, source: file }) : err(parsed.error);
  }
  return ok({ config: DEFAULT_CONFIG, source: undefined });
}

/** Config paths override defaults; flags and env (later) override config. */
export function resolvePaths(config: MetatorConfig): MetatorPaths {
  const set = Object.entries(config.paths).filter(([, v]) => v !== undefined);
  return { ...DEFAULT_PATHS, ...(Object.fromEntries(set) as Partial<MetatorPaths>) };
}
