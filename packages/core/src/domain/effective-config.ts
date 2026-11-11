import type { MetatorConfig } from "./config.ts";
import { optionByKey } from "./option-registry.ts";

/**
 * The repository's configuration as the code should use it: the repository-scope options that
 * replaced older fields (`supervisor.*`, `notify.command`) are laid over those fields, so one
 * place decides which wins and every reader of `config.supervisor` or `config.notify` sees the
 * value `metator config get` reports. An option the file does not set, or sets to a value its
 * definition refuses, leaves the field as it is (the refusal is a diagnostic of `config list`).
 */
export function withRepoOptions(config: MetatorConfig): MetatorConfig {
  const set = <T>(key: string): T | undefined => {
    if (!(key in config.options)) return undefined;
    const parsed = optionByKey(key)?.parse(config.options[key]);
    return parsed?.ok ? (parsed.value as T) : undefined;
  };
  const command = set<string>("notify.command");
  const notify = command === undefined ? config.notify : command === "" ? undefined : { command };
  const { notify: _old, ...rest } = config;
  return {
    ...rest,
    ...(notify ? { notify } : {}),
    supervisor: {
      ...config.supervisor,
      wipLimit: set<number>("supervisor.wipLimit") ?? config.supervisor.wipLimit,
      respawn: {
        enabled: set<boolean>("supervisor.respawn") ?? config.supervisor.respawn.enabled,
        maxAttempts: set<number>("supervisor.respawnAttempts") ?? config.supervisor.respawn.maxAttempts,
      },
      idleThresholdMs: set<number>("supervisor.idleThresholdMs") ?? config.supervisor.idleThresholdMs,
      hostOrder: set<string[]>("supervisor.hostOrder") ?? config.supervisor.hostOrder,
    },
  };
}
