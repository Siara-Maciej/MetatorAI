import type { MetatorConfig } from "./config.ts";
import { SECRET_GLOBS } from "./hook.ts";
import { optionByKey } from "./option-registry.ts";

/**
 * What an agent's host session may reach (ADR-0102, ADR-0104). A permission decides whether a
 * command runs; only the sandbox limits what the session, every command it runs and everything
 * those start (a test's dependencies, a script the agent wrote) can read, write and connect to.
 * MetatorAI starts every host session it runs, Claude Code and Copilot CLI alike, inside it.
 */
export interface SandboxPolicy {
  /** Paths no sandboxed process reads, beside the repository's secret files. */
  readonly denyRead: readonly string[];
  /** Paths writable beside the repository, the host's own state and the temporary directory. */
  readonly allowWrite: readonly string[];
  /** Hosts a sandboxed process may connect to, beside the host's own API. */
  readonly allowedDomains: readonly string[];
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
  };
}

/**
 * What a host needs to work inside the sandbox, as its descriptor says: the hosts its own API
 * lives on and the files it keeps its state in (`~` is the home directory).
 */
export interface HostSandboxNeeds {
  readonly domains: readonly string[];
  readonly writable: readonly string[];
}

export const NO_SANDBOX_NEEDS: HostSandboxNeeds = { domains: [], writable: [] };

/**
 * The settings of the sandbox runtime (`@anthropic-ai/sandbox-runtime`, its `--settings` file):
 * reads are open but for `denyRead` (`allowRead` opens a file back), writes are closed but for
 * `allowWrite`, the network is closed but for `allowedDomains`.
 */
export interface SandboxSettings {
  readonly network: { readonly allowedDomains: readonly string[]; readonly deniedDomains: readonly string[] };
  readonly filesystem: {
    readonly denyRead: readonly string[];
    readonly allowRead: readonly string[];
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
  };
}

/** Where one session starts. */
export interface SandboxPlace {
  /** The repository's root: its runs and worktrees are under it. */
  readonly root: string;
  /** The session's working directory (the repository, or a run's worktree). */
  readonly cwd: string;
  /** The temporary directory (tests and builds write there). */
  readonly temp: string;
  /** The daemon's address as `host:port`, when one serves the repository: hooks report to it. */
  readonly daemon?: string;
}

const unique = (items: readonly string[]): string[] => [...new Set(items)];

/**
 * One policy, one host, one place: the settings the session starts under. The repository's
 * secret files (the guard's `SECRET_GLOBS`, from the session's directory down) are unreadable on
 * both hosts alike; their examples (`.env.example`) stay readable.
 */
export function sandboxSettings(
  policy: SandboxPolicy,
  needs: HostSandboxNeeds,
  place: SandboxPlace,
): SandboxSettings {
  const secrets = SECRET_GLOBS.filter((g) => !g.startsWith("!"));
  const examples = SECRET_GLOBS.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  return {
    network: {
      allowedDomains: unique([
        ...needs.domains,
        ...policy.allowedDomains,
        ...(place.daemon ? [place.daemon] : []),
      ]),
      deniedDomains: [],
    },
    filesystem: {
      denyRead: unique([...policy.denyRead, ...secrets]),
      allowRead: examples,
      allowWrite: unique([place.root, place.cwd, place.temp, ...needs.writable, ...policy.allowWrite]),
      denyWrite: [],
    },
  };
}

/**
 * The daemon's address as the sandbox's allow list takes it: an IP literal with its port (a name
 * would resolve to loopback, which the sandbox refuses), from `http://<host>:<port>`.
 */
export function daemonAddress(url: string): string | undefined {
  const m = /^https?:\/\/(\[[^\]]+\]|[^/:]+):(\d+)/.exec(url);
  if (!m) return undefined;
  const host = m[1] === "localhost" ? "127.0.0.1" : (m[1] as string);
  return `${host}:${m[2]}`;
}

/**
 * The programs a Linux sandbox is made of: bubblewrap's `bwrap`, `socat` for its network proxy,
 * and ripgrep's `rg`, which the sandbox runtime needs to find the files a `denyRead` pattern
 * names (it does not start without it).
 */
export const LINUX_SANDBOX_PROGRAMS: readonly string[] = ["bwrap", "socat", "rg"];

/**
 * Why this machine cannot hold a sandbox, or undefined when it can: macOS has its own
 * (`sandbox-exec`), Linux needs `LINUX_SANDBOX_PROGRAMS`, native Windows has none here.
 */
export function sandboxUnavailable(platform: string, missing: readonly string[]): string | undefined {
  if (platform === "win32") return "native Windows has no sandbox here: run the AI host inside WSL2";
  if (platform === "linux" && missing.length > 0) return `${missing.join(", ")} is not installed`;
  if (platform !== "linux" && platform !== "darwin") return `${platform} has no sandbox here`;
  return undefined;
}

/**
 * Whether the policy can hold on this machine (`metator doctor`): what is off, what is missing
 * and what the sandbox does not cover even when it is on.
 */
export function sandboxIsolation(
  policy: SandboxPolicy | undefined,
  platform: string,
  missing: readonly string[],
  /** Why this installation cannot start the sandbox runtime itself (`srt`); undefined when it can. */
  runtimeMissing?: string,
): { readonly status: "ok" | "warn"; readonly message: string; readonly fix?: string } {
  if (!policy)
    return {
      status: "warn",
      message:
        "agents' host sessions run without a sandbox: a script or a dependency they start can read every file you can",
      fix: "metator config set sandbox.enabled true --scope repo",
    };
  if (platform === "win32")
    return {
      status: "warn",
      message:
        "the sandbox is on, but native Windows has none: host sessions run unsandboxed here; in WSL2 they are held",
      fix: "run MetatorAI and the AI host inside WSL2",
    };
  if (runtimeMissing)
    return {
      status: "warn",
      message: `the sandbox is on, but ${runtimeMissing}: host sessions cannot start in it`,
      fix: "Reinstall the MetatorAI app (its metator-resources folder holds the sandbox runtime), or run metator from a checkout or the npm package",
    };
  const why = sandboxUnavailable(platform, missing);
  if (why)
    return {
      status: "warn",
      message: `the sandbox is on, but ${why}: host sessions cannot start in it`,
      fix: "install the packages bubblewrap socat ripgrep (apt-get install bubblewrap socat ripgrep, dnf install bubblewrap socat ripgrep)",
    };
  return {
    status: "ok",
    message:
      "every host session MetatorAI starts (Claude Code and Copilot CLI) runs in the operating system's sandbox, with its commands, hooks and MCP servers; a claude or copilot you start by hand does not",
  };
}
