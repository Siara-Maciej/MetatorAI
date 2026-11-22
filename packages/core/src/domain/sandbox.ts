import type { MetatorConfig } from "./config.ts";
import { optionByKey } from "./option-registry.ts";

/**
 * What the shell commands of an agent may reach (ADR-0102), for a host that can hold them in an
 * operating-system sandbox. A permission decides whether a command runs; only the sandbox limits
 * what the command, and everything it starts (a test's dependencies, a script the agent wrote),
 * can read, write and connect to.
 */
export interface SandboxPolicy {
  /** Paths no sandboxed process reads, beside the repository's secret files (the host's Read deny rules). */
  readonly denyRead: readonly string[];
  /** Paths writable beside the repository. */
  readonly allowWrite: readonly string[];
  /** Hosts a sandboxed process may connect to. */
  readonly allowedDomains: readonly string[];
  /** Command patterns that run outside the sandbox (tools that cannot run inside one). */
  readonly excludedCommands: readonly string[];
}

/** The repository's sandbox options as one policy; undefined while `sandbox.enabled` is off. */
export function sandboxPolicy(config: MetatorConfig): SandboxPolicy | undefined {
  const value = <T>(key: string): T => {
    const option = optionByKey(key);
    const parsed = key in config.options ? option?.parse(config.options[key]) : undefined;
    return (parsed?.ok ? parsed.value : option?.defaultValue) as T;
  };
  if (!value<boolean>("sandbox.enabled")) return undefined;
  return {
    denyRead: value<readonly string[]>("sandbox.denyRead"),
    allowWrite: value<readonly string[]>("sandbox.allowWrite"),
    allowedDomains: value<readonly string[]>("sandbox.allowedDomains"),
    excludedCommands: value<readonly string[]>("sandbox.excludedCommands"),
  };
}

/** The programs a Linux sandbox is made of (bubblewrap's `bwrap`, and `socat` for its network proxy). */
export const LINUX_SANDBOX_PROGRAMS: readonly string[] = ["bwrap", "socat"];

/**
 * Whether the policy can hold on this machine (`metator doctor`): what is off, what is missing
 * and what the sandbox does not cover even when it is on.
 */
export function sandboxIsolation(
  policy: SandboxPolicy | undefined,
  platform: string,
  missing: readonly string[],
): { readonly status: "ok" | "warn"; readonly message: string; readonly fix?: string } {
  if (!policy)
    return {
      status: "warn",
      message:
        "agents' shell commands run without a sandbox: a script or a dependency they start can read every file you can",
      fix: "metator config set sandbox.enabled true --scope repo, then metator generate --hooks",
    };
  if (platform === "win32")
    return {
      status: "warn",
      message:
        "the sandbox is on, but Windows has none: commands run unsandboxed here; in WSL2 they are held",
      fix: "run the AI host inside WSL2",
    };
  if (platform === "linux" && missing.length > 0)
    return {
      status: "warn",
      message: `the sandbox is on, but ${missing.join(" and ")} is not installed: commands cannot be held in it`,
      fix: "install the packages bubblewrap socat (apt-get install bubblewrap socat, dnf install bubblewrap socat)",
    };
  return {
    status: "ok",
    message:
      "shell commands of Claude Code run in the operating system's sandbox; its hooks and MCP servers, and Copilot's commands, do not",
  };
}
