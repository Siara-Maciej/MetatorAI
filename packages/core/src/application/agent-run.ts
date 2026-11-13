import type { AgentAnswer, AgentEvent, AgentQuestion, AgentTask } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { AgentHost } from "../ports/index.ts";

/** The host with this id; an unknown id is a usage error that lists the hosts there are. */
export function hostNamed<H>(hosts: ReadonlyMap<string, H>, id: string): Result<H, MetatorError> {
  const host = hosts.get(id);
  return host
    ? ok(host)
    : err(MetatorError.usage(`unknown host ${id}`, `Hosts: ${[...hosts.keys()].join(", ")}.`));
}

/** One agent on the person's AI host until it stops; a failed result is COMMAND_FAILED with a hint. */
export async function runAgent(input: {
  readonly host: AgentHost;
  readonly hostName: string;
  readonly task: AgentTask;
  readonly deny: AgentAnswer;
  readonly hint: string;
  readonly onEvent?: (e: AgentEvent) => void;
  readonly ask?: (q: AgentQuestion) => Promise<AgentAnswer>;
}): Promise<Result<void, MetatorError>> {
  let failure: string | undefined;
  for await (const e of input.host.run(input.task, input.ask ?? (async () => input.deny))) {
    input.onEvent?.(e);
    if (e.type === "result" && !e.ok) failure = e.text || `${input.task.agent} stopped without a result`;
  }
  return failure === undefined
    ? ok(undefined)
    : err(new MetatorError("COMMAND_FAILED", `${input.hostName}: ${failure}`, { hint: input.hint }));
}
