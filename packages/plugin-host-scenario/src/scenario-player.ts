import { type AgentScenario, AgentScenarioDocument, err, MetatorError, ok, type Result } from "@metator/core";
import { parse } from "yaml";

/** One start of an agent in a scenario: the steps it plays and the id its session is resumed by. */
export interface ScenarioTurn {
  readonly steps: AgentScenario["agents"][string][number];
  readonly sessionId: string;
}

/**
 * The scenario both scenario hosts play (ADR-0051): read once, at the first start. Each start of
 * an agent takes the agent's next entry and the last entry repeats; a resumed session (a new
 * process) plays the entry after the one its id names.
 */
export class ScenarioPlayer {
  private readonly starts = new Map<string, number>();
  private loaded: Promise<Result<AgentScenario, MetatorError>> | undefined;

  /** A scenario, or the path of an AgentScenario file read at the first start. */
  constructor(private readonly source: AgentScenario | string) {}

  /** Reads the scenario file; a missing or invalid one is an error value with the reason. */
  static async load(file: string): Promise<Result<AgentScenario, MetatorError>> {
    const handle = Bun.file(file);
    if (!(await handle.exists())) return err(MetatorError.notFound(`scenario ${file}`));
    let raw: unknown;
    try {
      raw = parse(await handle.text());
    } catch (e) {
      return err(new MetatorError("PARSE_FAILED", `${file}: ${(e as Error).message}`));
    }
    return AgentScenarioDocument.parse(raw, file);
  }

  /**
   * The agent's next turn; `standIn` names the entry that plays for an agent the scenario does
   * not list. Undefined when the scenario has neither. `atLeast` is the number of turns the
   * session being continued has already played (0 for a new one).
   */
  async next(
    agent: string,
    atLeast: number,
    standIn?: string,
  ): Promise<Result<ScenarioTurn | undefined, MetatorError>> {
    this.loaded ??=
      typeof this.source === "string" ? ScenarioPlayer.load(this.source) : Promise.resolve(ok(this.source));
    const scenario = await this.loaded;
    if (scenario.isErr()) return err(scenario.error);
    const entries = scenario.value.agents[agent] ?? (standIn ? scenario.value.agents[standIn] : undefined);
    if (!entries) return ok(undefined);
    const n = Math.max(this.starts.get(agent) ?? 0, atLeast);
    this.starts.set(agent, n + 1);
    return ok({
      steps: entries[Math.min(n, entries.length - 1)] ?? [],
      sessionId: `scenario-${agent}-${n + 1}`,
    });
  }
}
