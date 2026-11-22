import { type HookResponse, type MetatorError, ok, type Result, readHookInput } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
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

/**
 * A run started from a pane (the chat where a person gave the task): the pane remembers it, as that
 * task's main terminal. Sent once with the pane's token, never waited for long; no daemon, nothing.
 */
export async function paneStartedRun(
  runId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  root: string = process.cwd(),
): Promise<void> {
  if (!env.METATOR_PANE_ID || !env.METATOR_PANE_TOKEN) return;
  const daemon = findDaemon(root);
  if (daemon.isErr()) return;
  await callDaemon(
    daemon.value,
    "POST",
    `/panes/${encodeURIComponent(env.METATOR_PANE_ID)}/started-run`,
    { runId },
    paneHeaders(env),
    1_000,
  ).catch(() => undefined);
}

/**
 * What a person sent in a run's session themselves (the host's user-prompt hook, ADR-0093): the
 * daemon tells the task's main chat in one line. Sent once with the pane's token, never waited for
 * long; no daemon, no run pane, or no words: nothing to say.
 */
export async function paneSaid(
  prompt: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
  root: string = process.cwd(),
): Promise<void> {
  if (!env.METATOR_PANE_ID || !env.METATOR_PANE_TOKEN || !env.METATOR_RUN) return;
  if (typeof prompt !== "string" || prompt.trim() === "") return;
  const daemon = findDaemon(root);
  if (daemon.isErr()) return;
  await callDaemon(
    daemon.value,
    "POST",
    `/panes/${encodeURIComponent(env.METATOR_PANE_ID)}/said`,
    { text: prompt },
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

export function registerGuardCommands(
  program: Command,
  { action, container, stdin, runs }: CommandContext,
): void {
  const guard = program
    .command("guard")
    .description("Host hooks: read the hook payload on stdin, answer in the hook protocol (ADR-0038)");

  const events = [
    [
      "pre-tool",
      "PreToolUse: deny secrets, commands that never run (guard.commands), edits outside plan scope; ask for commit, push, merge, rebase unless the person consented",
      "guardPreTool",
    ],
    ["post-edit", "PostToolUse: rule violations of the edited files as context", "guardPostEdit"],
    ["stop", "Stop: an active run at a working stage must be advanced or escalated first", "guardStop"],
    [
      "subagent-output",
      "SubagentStop: the run's JSON artifacts must be valid documents",
      "guardSubagentOutput",
    ],
    [
      "user-prompt",
      "UserPromptSubmit: the person's own words that ask for a guarded command (commit, push) are their consent to it, once",
      "guardUserPrompt",
    ],
  ] as const;
  for (const [name, description, token] of events) {
    meta(guard.command(name), { audience: "hook" })
      .description(description)
      .action(
        action(async () => {
          const beat = paneHeartbeat();
          const given = payload(await stdin());
          // A message the person sent in a run's session: its task's main chat hears of it.
          const said = name === "user-prompt" ? paneSaid((given as { prompt?: unknown }).prompt) : undefined;
          // What the daemon typed into this pane is kept where the daemon works (the checkout,
          // also for a pane in a run's worktree): its own lines are no person's word.
          const pane = process.env.METATOR_PANE_ID;
          const prompt = (given as { prompt?: unknown }).prompt;
          const typedBy =
            name === "user-prompt" && pane && typeof prompt === "string"
              ? await runs().resolve("paneTyped").by(pane, prompt)
              : undefined;
          const result = await container()
            .resolve(token)
            // A session `metator run drive` started (the host sets METATOR_DRIVEN): the drive
            // moves the run, so the guards neither let the agent do it nor ask it to.
            // A pane under the daemon (METATOR_PANE_ID) is no drive's session: its consents are
            // the pane's, a person can be asked there, and its conductor or chat steers runs.
            .execute(given, {
              driven: Boolean(process.env.METATOR_DRIVEN),
              ...(process.env.METATOR_PANE_ID ? { pane: process.env.METATOR_PANE_ID } : {}),
              ...(process.env.METATOR_RUN ? { run: process.env.METATOR_RUN } : {}),
              ...(typedBy ? { typedBy } : {}),
            });
          // Why the guard asked about (or refused) a command in a pane: kept where the daemon
          // works, for the card the host's own prompt becomes (Claude Code does not show it).
          const command = readHookInput(given).input.command;
          const decision = (result.isOk() ? result.value?.hookSpecificOutput : undefined) as
            | { permissionDecision?: string; permissionDecisionReason?: string }
            | undefined;
          if (
            name === "pre-tool" &&
            pane &&
            typeof command === "string" &&
            (decision?.permissionDecision === "ask" || decision?.permissionDecision === "deny") &&
            decision.permissionDecisionReason
          )
            await runs()
              .resolve("guardAsked")
              .record(pane, command, decision.permissionDecision, decision.permissionDecisionReason);
          await beat;
          await said;
          return answer(result, name);
        }),
      );
  }

  meta(guard.command("session-start"), { audience: "hook" })
    .description("SessionStart: the active run and a missing index as context")
    .action(
      action(async () => answer(await container().resolve("guardSessionStart").execute(), "session-start")),
    );

  meta(guard.command("precompact"), { audience: "hook" })
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
