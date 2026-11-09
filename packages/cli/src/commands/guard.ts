import { type HookResponse, type MetatorError, ok, type Result } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext, Outcome } from "../context.ts";
import { callDaemon, findDaemon, paneHeaders } from "../daemon-client.ts";

/**
 * A hook call from a pane under the daemon is proof the agent works (R3): the pane's heartbeat,
 * carried by its token, sent once and never waited for long. No daemon or no pane: nothing to say.
 */
export async function paneHeartbeat(
  env: Readonly<Record<string, string | undefined>> = process.env,
  root: string = process.cwd(),
): Promise<void> {
  if (!env.METATOR_PANE_ID || !env.METATOR_PANE_TOKEN) return;
  const daemon = findDaemon(root);
  if (daemon.isErr()) return;
  await callDaemon(
    daemon.value,
    "POST",
    `/panes/${encodeURIComponent(env.METATOR_PANE_ID)}/heartbeat`,
    {},
    paneHeaders(env),
    1_000,
  ).catch(() => undefined);
}

/** Parses the hook payload; an empty or invalid one is an empty object (the host decides). */
function payload(text: string): unknown {
  try {
    return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
  } catch {
    return {};
  }
}

/** A guard that fails says so to the user and leaves the decision to the host's own rules. */
function answer(result: Result<HookResponse, MetatorError>, name: string): Outcome {
  return result.isOk()
    ? { result: ok(null), hook: result.value }
    : { result: ok(null), hook: { systemMessage: `metator guard ${name}: ${result.error.message}` } };
}

export function registerGuardCommands(program: Command, { action, container, stdin }: CommandContext): void {
  const guard = program
    .command("guard")
    .description("Host hooks: read the hook payload on stdin, answer in the hook protocol (ADR-0038)");

  const events = [
    [
      "pre-tool",
      "PreToolUse: deny secrets, destructive commands, unapproved push, edits outside plan scope",
      "guardPreTool",
    ],
    ["post-edit", "PostToolUse: rule violations of the edited files as context", "guardPostEdit"],
    ["stop", "Stop: an active run at a working stage must be advanced or escalated first", "guardStop"],
    [
      "subagent-output",
      "SubagentStop: the run's JSON artifacts must be valid documents",
      "guardSubagentOutput",
    ],
  ] as const;
  for (const [name, description, token] of events) {
    guard
      .command(name)
      .description(description)
      .action(
        action(async () => {
          const beat = paneHeartbeat();
          const result = await container()
            .resolve(token)
            // A session `metator run drive` started (the host sets METATOR_DRIVEN): the drive
            // moves the run, so the guards neither let the agent do it nor ask it to.
            .execute(payload(await stdin()), { driven: Boolean(process.env.METATOR_DRIVEN) });
          await beat;
          return answer(result, name);
        }),
      );
  }

  guard
    .command("session-start")
    .description("SessionStart: the active run and a missing index as context")
    .action(
      action(async () => answer(await container().resolve("guardSessionStart").execute(), "session-start")),
    );

  guard
    .command("precompact")
    .description("PreCompact: write a run checkpoint to log.md before the context is compacted")
    .action(
      action(async () => {
        const checkpoint = await container().resolve("checkpointRun").execute({});
        // No run, nothing to keep: compaction goes ahead either way.
        return answer(
          checkpoint.isOk() || checkpoint.error.code === "NOT_FOUND" ? ok(null) : checkpoint.map(() => null),
          "precompact",
        );
      }),
    );
}
