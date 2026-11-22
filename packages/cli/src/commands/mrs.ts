import {
  err,
  MetatorError,
  ok,
  type Result,
  THREAD_KINDS,
  THREAD_STATES,
  type ThreadKind,
  type ThreadState,
} from "@metator/core";
import { type Command, Option } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { callDaemon, findDaemon, inRepo, paneHeaders } from "../daemon-client.ts";
import { byOption } from "../options.ts";
import { asPerson } from "../who.ts";

/**
 * `metator mrs` (T3, design/14 §4): reviews of my own pull (merge) requests. The daemon keeps
 * them current (`serve --reviews-ms`); the agent of `mt-review-response` records what it made
 * of each thread (`triage`); `send` and `resolve` change the host and record the person who ran them.
 */
export function registerMrsCommands(program: Command, ctx: CommandContext): void {
  const { action, container } = ctx;
  const mrs = program
    .command("mrs")
    .description("Reviews of my open pull requests: threads, proposed replies, the run that answers them");
  const reviews = () => container().resolve("myReviews");

  meta(mrs.command("list"), { audience: "person" })
    .description(
      "My reviewed requests with their open threads, the new ones nobody analysed, the answering run, and the cards",
    )
    .action(
      action(async () => {
        const all = await reviews().overview();
        if (all.isErr()) return { result: err(all.error) };
        return {
          result: ok({
            cards: all.value.cards,
            requests: all.value.requests.map((r) => ({
              id: r.id,
              number: r.number,
              title: r.title,
              ...(r.branch ? { branch: r.branch } : {}),
              ...(r.url ? { url: r.url } : {}),
              threads: r.threads.length,
              open: r.threads.filter((t) => t.state === "open").length,
              proposed: r.threads.filter((t) => t.reply && !t.repliedAt).length,
              fresh: r.fresh,
              ...(r.runId ? { runId: r.runId } : {}),
            })),
          }),
        };
      }),
    );

  mrs
    .command("show")
    .description("One request's threads: who said what where, its kind, the proposed reply, its state")
    .argument("<id>", "the request, as `mrs list` names it (github-acme-shop-45)")
    .action(action(async (id: string) => ({ result: await reviews().show(id) })));

  mrs
    .command("scan")
    .description("Read the hosts now: keep the threads, start the answering run for new ones")
    .action(
      action(async () => {
        const report = await reviews().scan();
        if (report.isErr()) return { result: err(report.error) };
        return { result: ok(report.value), warnings: [...report.value.errors] };
      }),
    );

  mrs
    .command("triage")
    .description("Record what was made of a thread: its kind, a proposed reply, whether the plan covers it")
    .argument("<id>", "the request")
    .requiredOption("--thread <thread>", "the thread's id")
    .addOption(new Option("--kind <kind>", "what the thread is").choices(THREAD_KINDS))
    .option("--reply <text>", "the reply to propose (sent only by `mrs send`)")
    .addOption(new Option("--state <state>", "where the thread stands").choices(THREAD_STATES))
    .action(
      action(
        async (
          id: string,
          opts: { thread: string; kind?: ThreadKind; reply?: string; state?: ThreadState },
        ) => ({
          result: await reviews().triage(id, opts.thread, {
            ...(opts.kind ? { kind: opts.kind } : {}),
            ...(opts.reply !== undefined ? { reply: opts.reply } : {}),
            ...(opts.state ? { state: opts.state } : {}),
          }),
        }),
      ),
    );

  mrs
    .command("send")
    .description(
      "Post the proposed replies not sent yet to the host, in one consent: all, only some (--only) or all but some (--skip)",
    )
    .argument("<id>", "the request")
    // Posting to the host is a person's decision, as an approval is: never under the login name.
    .addOption(byOption("the person who decides to send them", "decision"))
    .option("--only <threads>", "send only these threads (t1,t3)", threadList)
    .option("--skip <threads>", "send all but these threads (t2)", threadList)
    .action(
      action(async (id: string, opts: { by?: string; only?: string[]; skip?: string[] }) =>
        asPerson(
          container(),
          opts.by,
          async (by) => ({
            result: await reviews().send(id, {
              by,
              ...(opts.only ? { only: opts.only } : {}),
              ...(opts.skip ? { skip: opts.skip } : {}),
            }),
          }),
          "decision",
        ),
      ),
    );

  mrs
    .command("analyse")
    .description(
      "Analyse a review of my MR in a pane you see: every new thread, proposed replies and fixes (through the daemon)",
    )
    .argument("<id>", "the request")
    .addOption(byOption("who asks for it"))
    .option("--host <host>", "the AI host of the responder")
    .action(
      action(async (id: string, opts: { by?: string; host?: string }) =>
        asPerson(container(), opts.by, async (by) => {
          const daemon = findDaemon(ctx.start());
          if (daemon.isErr())
            return {
              result: err(
                MetatorError.usage(
                  "analysing in a pane needs the daemon (`metator serve`)",
                  "Start the app.",
                ),
              ) as Result<never, MetatorError>,
            };
          return {
            result: await callDaemon(
              daemon.value,
              "POST",
              inRepo(`/mrs/${encodeURIComponent(id)}/analyse`, container().resolve("root")),
              { by, ...(opts.host ? { host: opts.host } : {}) },
              paneHeaders(),
            ),
          };
        }),
      ),
    );

  mrs
    .command("resolve")
    .description("Close a thread at the host")
    .argument("<id>", "the request")
    .requiredOption("--thread <thread>", "the thread's id")
    .addOption(byOption("the person who decides to close it", "decision"))
    .action(
      action(async (id: string, opts: { thread: string; by?: string }) =>
        asPerson(
          container(),
          opts.by,
          async (by) => ({ result: await reviews().resolve(id, opts.thread, { by }) }),
          "decision",
        ),
      ),
    );
}

/** `t1,t3` (or repeated words): thread ids, each once. */
function threadList(value: string, previous: string[] = []): string[] {
  return [...new Set([...previous, ...value.split(/[\s,]+/).filter(Boolean)])];
}
