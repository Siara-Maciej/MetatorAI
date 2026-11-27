import { err, MetatorError, type SessionView } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { callDaemon, findDaemon, inRepo, paneHeaders } from "../daemon-client.ts";
import { byOption } from "../options.ts";
import { who } from "../who.ts";

/**
 * `session` (ADR-0093): the sessions of a task, and the person's words for one of them. The
 * daemon owns the panes and checks who calls: the task's main chat (its pane's token) or a
 * person. What is told is typed when the session's agent is idle; an interrupt stops it first.
 */
export function registerSessionCommands(program: Command, ctx: CommandContext): void {
  const { action, container } = ctx;
  const session = program
    .command("session")
    .description(
      "The agent sessions of a task under the daemon: list them, tell one the person's words, interrupt one",
    );

  /** A call to the daemon; `repo` names the repository of the pane in a folder of repositories. */
  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown, repo?: string) => {
    const daemon = findDaemon(ctx.start());
    if (daemon.isErr()) return daemon;
    return callDaemon<T>(
      daemon.value,
      method,
      repo === undefined ? path : inRepo(path, repo),
      body,
      paneHeaders(),
    );
  };

  meta(session.command("list"), { audience: "person", reads: true, folder: true })
    .description("The sessions of a task (or all): pane, repository, role, agent, state")
    .option("--task <run>", "the task: its main chat, its run's sessions and its child runs' sessions")
    .action(
      action(async (opts: { task?: string }) => ({
        result: await call<{ sessions: SessionView[] }>(
          "GET",
          `/sessions${opts.task ? `?task=${encodeURIComponent(opts.task)}` : ""}`,
        ),
      })),
    );

  const steer = (name: "tell" | "interrupt", description: string) =>
    meta(session.command(`${name} <pane>`), { folder: true })
      .description(description)
      .requiredOption("--text <words>", "the person's words, as they said them")
      .option("--repo <name>", "the pane's repository, as `session list` names it (default: this one)")
      .addOption(byOption("who says it, from a terminal of their own"))
      .action(
        action(async (pane: string, opts: { text: string; repo?: string; by?: string }) => {
          if (opts.text.trim() === "")
            return { result: err(MetatorError.usage("say what to tell: --text <the person's words>")) };
          // From a pane the daemon knows who calls (its token); a person gives their name.
          let by: string | undefined;
          if (!process.env.METATOR_PANE_TOKEN) {
            const name = await who(container(), opts.by);
            if (name.isErr()) return { result: name };
            by = name.value;
          }
          return {
            result: await call(
              "POST",
              `/panes/${encodeURIComponent(pane)}/${name}`,
              { text: opts.text, ...(by ? { by } : {}) },
              opts.repo ?? container().resolve("root"),
            ),
          };
        }),
      );
  steer(
    "tell",
    "Tell a session the person's words: typed into it when its agent is idle (queued until then), never over a prompt or a question it asked",
  );
  steer(
    "interrupt",
    "Stop what a session's agent does and give it the person's words now: Esc, the words, then Enter",
  );
}
