import { err, MetatorError, ok, type Result, threadTreeOf } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext, Outcome } from "../context.ts";
import { callDaemon, findDaemon, inRepo, paneHeaders } from "../daemon-client.ts";
import { byOption } from "../options.ts";
import { renderThread, renderThreadTree } from "../render.ts";
import { who } from "../who.ts";

/** Why a thread made without a daemon has no chat terminal yet. */
const NO_PANE =
  "no daemon serves this repository: the thread has no chat terminal yet. Start one (`metator serve`, or the app), then `metator thread reopen <id>`.";

/**
 * `thread` (ADR-0095): one thread per topic, with its chat terminal. Through the daemon that
 * serves the repository (it owns the panes), else on the files. The agent of a thread's chat
 * reads it first (`thread show`) and keeps its summary (`thread summary`); `--thread` defaults to
 * the thread whose chat runs the command (`$METATOR_PANE_ID`). In a folder of repositories the
 * threads are the folder's own (ADR-0113).
 */
export function registerThreadCommands(program: Command, ctx: CommandContext): void {
  const { action, container } = ctx;
  const thread = program
    .command("thread")
    .description(
      "Threads: one per topic, with its chat terminal; what MetatorAI keeps of it (summary, runs, facts) is what a new session reads first",
    );

  /** The daemon of this repository, when one serves it. */
  const daemon = () => {
    const found = findDaemon(ctx.start());
    return found.isOk() ? found.value : undefined;
  };
  const call = <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<Result<T, MetatorError>> =>
    callDaemon<T>(
      daemon() as NonNullable<ReturnType<typeof daemon>>,
      method,
      inRepo(path, container().resolve("root")),
      body,
      paneHeaders(),
    );

  /** The thread a command is about: given, else the one whose chat runs it. */
  const threadOf = async (given: string | undefined): Promise<Result<string, MetatorError>> => {
    if (given) return ok(given);
    const pane = process.env.METATOR_PANE_ID;
    if (!pane)
      return err(
        MetatorError.usage(
          "name the thread: --thread <id>",
          "`metator thread list` lists them; inside a thread's chat it is that thread.",
        ),
      );
    return (await container().resolve("threads").ofPane(pane)).map((t) => t.id);
  };

  /** The tree on the files, when no daemon serves the repository. */
  const localTree = async (c: MetatorContainer) => {
    const overview = await c.resolve("workOverview").execute();
    return threadTreeOf([
      { threads: c.resolve("threads"), runs: overview.isOk() ? overview.value.runs : [] },
    ]);
  };

  const id = (positional: string | undefined, opts: { thread?: string }) => positional ?? opts.thread;

  meta(thread.command("new"), { folder: true })
    .description(
      "A new thread with its chat terminal (the conversation agent): for a new topic, after the person said yes",
    )
    .requiredOption("--title <words>", "the topic in a few words (at most 80 characters)")
    .option("--carry <line>", "one line of context the new chat gets as its first message")
    .option("--host <id>", "the host of the chat (default: the first installed of supervisor.hostOrder)")
    .addOption(byOption("who opens it"))
    .action(
      action(
        async (opts: { title: string; carry?: string; host?: string; by?: string }): Promise<Outcome> => {
          const by = await who(container(), opts.by);
          if (by.isErr()) return { result: by };
          const input = {
            title: opts.title,
            by: by.value,
            ...(opts.carry ? { carry: opts.carry } : {}),
            ...(opts.host ? { host: opts.host } : {}),
          };
          if (daemon()) return { result: await call("POST", "/threads", input) };
          const made = await container()
            .resolve("threads")
            .create({ ...input, pane: false });
          return { result: made.map(({ thread: t }) => ({ thread: t, noPane: NO_PANE })) };
        },
      ),
    );

  meta(thread.command("show [thread]"), { render: renderThread, folder: true })
    .description(
      "The thread: title, summary, facts, its runs with their state, issues. The chat agent's first action in a session",
    )
    .option("--thread <id>", "the thread (default: the one whose chat runs this)")
    .action(
      action(async (positional: string | undefined, opts: { thread?: string }) => {
        const tid = await threadOf(id(positional, opts));
        if (tid.isErr()) return { result: tid };
        if (daemon()) return { result: await call("GET", `/threads/${encodeURIComponent(tid.value)}`) };
        const shown = await container().resolve("threads").show(tid.value);
        if (shown.isErr()) return { result: shown };
        const tree = await localTree(container());
        return {
          result: tree.map(
            (t) =>
              [...t.threads, ...t.closed].find((n) => n.id === tid.value) ?? { ...shown.value, tasks: [] },
          ),
        };
      }),
    );

  meta(thread.command("list"), { audience: "person", render: renderThreadTree, folder: true })
    .description(
      "Every thread with its tasks (open ones first), the runs without a chat, and the closed threads",
    )
    .action(
      action(async () => ({
        result: daemon() ? await call("GET", "/threads") : await localTree(container()),
      })),
    );

  meta(thread.command("summary"), { folder: true })
    .description(
      "Keep the thread's summary (Markdown, at most 1500 characters): when a decision was made, a run started or finished, or the person asks",
    )
    .requiredOption("--text <markdown>", "the summary; `-` reads it from stdin (a here-doc)")
    .option("--title <words>", "a better title, once the topic is clear")
    .option("--thread <id>", "the thread (default: the one whose chat runs this)")
    .action(
      action(async (opts: { text: string; title?: string; thread?: string }) => {
        const tid = await threadOf(opts.thread);
        if (tid.isErr()) return { result: tid };
        const text = opts.text === "-" ? await ctx.stdin() : opts.text;
        const input = { text, ...(opts.title ? { title: opts.title } : {}) };
        if (daemon())
          return { result: await call("POST", `/threads/${encodeURIComponent(tid.value)}/summary`, input) };
        return {
          result: (
            await container()
              .resolve("threads")
              .summary({ id: tid.value, ...input })
          ).map((t) => ({
            thread: t,
          })),
        };
      }),
    );

  meta(thread.command("close [thread]"), { folder: true })
    .description("Close the thread: its chat terminal ends (its session kept), its runs go on")
    .option("--thread <id>", "the thread (default: the one whose chat runs this)")
    .addOption(byOption("who closes it"))
    .action(
      action(async (positional: string | undefined, opts: { thread?: string; by?: string }) => {
        const tid = await threadOf(id(positional, opts));
        if (tid.isErr()) return { result: tid };
        const by = await who(container(), opts.by);
        if (by.isErr()) return { result: by };
        if (daemon())
          return {
            result: await call("POST", `/threads/${encodeURIComponent(tid.value)}/close`, { by: by.value }),
          };
        return { result: await container().resolve("threads").close({ id: tid.value, by: by.value }) };
      }),
    );

  meta(thread.command("reopen [thread]"), { folder: true })
    .description(
      "Open the thread's chat again: a paused one resumes, a closed thread continues its session or starts a new one told what it continues",
    )
    .option("--thread <id>", "the thread")
    .option("--host <id>", "the host of a new chat (default: the one it had)")
    .addOption(byOption("who reopens it"))
    .action(
      action(
        async (positional: string | undefined, opts: { thread?: string; host?: string; by?: string }) => {
          const tid = await threadOf(id(positional, opts));
          if (tid.isErr()) return { result: tid };
          const by = await who(container(), opts.by);
          if (by.isErr()) return { result: by };
          const found = findDaemon(ctx.start());
          // Only the daemon opens a chat terminal.
          if (found.isErr()) return { result: err(found.error) };
          return {
            result: await call("POST", `/threads/${encodeURIComponent(tid.value)}/reopen`, {
              by: by.value,
              ...(opts.host ? { host: opts.host } : {}),
            }),
          };
        },
      ),
    );
}
