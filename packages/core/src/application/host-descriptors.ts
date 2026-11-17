import { MetatorError } from "../domain/errors.ts";
import { err } from "../domain/result.ts";
import type {
  AgentHost,
  HostGenerator,
  InteractiveHost,
  ReadonlyFileSystem,
  SkillGenerator,
  Terminal,
} from "../ports/index.ts";

/**
 * What a host plugin offers, as plain data and factories: the composition root keeps a static
 * list of these and builds every host-related registration from it (ADR-0084: the plugin never
 * sees the container). A host leaves out what it does not do.
 */
export interface HostDescriptor {
  readonly id: string;
  /** The program the host runs: its name on PATH, and the variable that names another one. */
  readonly program?: { readonly env: string; readonly default: string };
  /** Runs one agent on one task; `runsProgram` says whether that needs `program` installed. */
  readonly agent?: {
    readonly runsProgram: boolean;
    /** Why this host may not start an agent here (the guard of `METATOR_NO_REAL_HOSTS`); it still counts as here. */
    readonly refused?: string;
    host(bin: string | undefined): AgentHost;
  };
  /** The host as an interactive CLI in a PTY. */
  interactive?(terminal: Terminal, bin: string | undefined): InteractiveHost;
  /** Writes the host's agent files and hooks; `agentFile` is where an agent's file goes. */
  readonly files?: {
    generator(): HostGenerator;
    skills(): SkillGenerator;
    agentFile(id: string): string;
  };
}

/** The programs given for hosts, by host id (`METATOR_<HOST>_BIN`). */
export type HostBins = Readonly<Record<string, string | undefined>>;

export interface HostStatus {
  readonly id: string;
  /** The program the host runs; absent for a host with none of its own. */
  readonly command?: string;
  readonly installed: boolean;
}

/** The programs the environment names for hosts: each descriptor's own variable. */
export function hostBins(
  hosts: readonly HostDescriptor[],
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const bins: Record<string, string> = {};
  for (const h of hosts) {
    const given = h.program ? env[h.program.env] : undefined;
    if (given) bins[h.id] = given;
  }
  return bins;
}

/** The program a host runs here: the one given for it, else its default name; none for a host without one. */
export function hostCommand(host: HostDescriptor, bins: HostBins): string | undefined {
  return host.program ? (bins[host.id] ?? host.program.default) : undefined;
}

/**
 * Why a host that drives agents cannot start here: only a host whose agents run through its
 * program needs that program (an SDK or a scenario does not). Undefined when nothing is wrong,
 * and for a host nobody knows.
 */
export function driveHostProblem(
  hosts: readonly HostDescriptor[],
  bins: HostBins,
  exists: (command: string) => boolean,
): (id: string) => string | undefined {
  return (id) => {
    const host = hosts.find((h) => h.id === id);
    if (!host?.agent?.runsProgram) return undefined;
    const command = hostCommand(host, bins);
    return command === undefined || exists(command) ? undefined : `\`${command}\` is not installed`;
  };
}

/**
 * Which hosts can start here, in the order given: the program each one runs, looked up when
 * asked. A host with no program of its own (the scenario a test plays) is always there.
 */
export function hostStatus(
  hosts: readonly HostDescriptor[],
  bins: HostBins,
  exists: (command: string) => boolean,
): HostStatus[] {
  return hosts.map((h) => {
    const command = hostCommand(h, bins);
    return command === undefined
      ? { id: h.id, installed: true }
      : { id: h.id, command, installed: exists(command) };
  });
}

/** The host files of the given agents that the repository holds (as `agents install` wrote them), by path. */
export async function agentDefinitionFiles(
  fs: Pick<ReadonlyFileSystem, "read">,
  hosts: readonly HostDescriptor[],
  ids: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids)
    for (const host of hosts) {
      if (!host.files) continue;
      const file = host.files.agentFile(id);
      const text = await fs.read(file);
      if (text.isOk()) out[file] = text.value;
    }
  return out;
}

/**
 * The variable a test suite sets so that nothing it does can reach a real AI host: only the
 * scenario host (no program of its own) and a stand-in program named by `METATOR_<HOST>_BIN` run.
 */
export const NO_REAL_HOSTS = "METATOR_NO_REAL_HOSTS";

/**
 * Why a host would be a real AI host here, as an agent driver or as an interactive CLI; undefined
 * for a host with no program of its own and for a stand-in program. An agent that does not run
 * through its program (an SDK) is real whatever program is named.
 */
export function realHostRefusal(
  host: HostDescriptor,
  bins: HostBins,
  use: "agent" | "interactive",
): string | undefined {
  if (!host.program) return undefined;
  const bin = bins[host.id];
  const standIn =
    bin !== undefined &&
    bin !== host.program.default &&
    !(use === "agent" && host.agent?.runsProgram === false);
  if (standIn) return undefined;
  return `${host.id} is a real AI host and ${NO_REAL_HOSTS} is set here: use the scenario host (METATOR_AGENT_SCENARIO) or a stand-in program (${host.program.env})`;
}

/** The hosts with every real AI host refused, as `METATOR_NO_REAL_HOSTS` asks: it says why instead of starting. */
export function withoutRealHosts(hosts: readonly HostDescriptor[], bins: HostBins): HostDescriptor[] {
  return hosts.map((h) => {
    const agentWhy = h.agent ? realHostRefusal(h, bins, "agent") : undefined;
    const sessionWhy = h.interactive ? realHostRefusal(h, bins, "interactive") : undefined;
    if (!agentWhy && !sessionWhy) return h;
    const { agent, interactive, ...rest } = h;
    // A refused host starts nothing: its one event says why, as a failed result.
    const refusedAgent = (why: string): AgentHost => ({
      id: h.id,
      run: async function* () {
        yield { type: "result", ok: false, text: why };
      },
    });
    const refusedSession = (why: string): InteractiveHost => ({
      id: h.id,
      start: async () => err(MetatorError.usage(why)),
      resume: async () => err(MetatorError.usage(why)),
    });
    return {
      ...rest,
      ...(agent
        ? {
            agent: agentWhy
              ? { runsProgram: agent.runsProgram, refused: agentWhy, host: () => refusedAgent(agentWhy) }
              : agent,
          }
        : {}),
      ...(interactive ? { interactive: sessionWhy ? () => refusedSession(sessionWhy) : interactive } : {}),
    };
  });
}
