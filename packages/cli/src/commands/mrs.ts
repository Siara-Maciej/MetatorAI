import { err, ok, THREAD_KINDS, THREAD_STATES, type ThreadKind, type ThreadState } from "@metator/core";
import { type Command, Option } from "commander";
import type { CommandContext } from "../context.ts";
import { BY_DEFAULT, who } from "../who.ts";

/**
 * `metator mrs` (T3, design/14 §4): reviews of my own pull (merge) requests. The daemon keeps
 * them current (`serve --reviews-ms`); the agent of `mt-review-response` records what it made
 * of each thread (`triage`); `send` and `resolve` change the host and need a person's name.
 */
export function registerMrsCommands(program: Command, { action, container }: CommandContext): void {
  const mrs = program
    .command("mrs")
    .description("Reviews of my open pull requests: threads, proposed replies, the run that answers them");
  const reviews = () => container().resolve("myReviews");

  mrs
    .command("list")
    .description("My reviewed requests with their open threads and the answering run")
    .action(
      action(async () => {
        const all = await reviews().list();
        if (all.isErr()) return { result: err(all.error) };
        return {
          result: ok({
            requests: all.value.map((r) => ({
              id: r.id,
              number: r.number,
              title: r.title,
              ...(r.branch ? { branch: r.branch } : {}),
              ...(r.url ? { url: r.url } : {}),
              threads: r.threads.length,
              open: r.threads.filter((t) => t.state === "open").length,
              proposed: r.threads.filter((t) => t.reply && !t.repliedAt).length,
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
    .description("Post every proposed reply that was not sent yet to the host")
    .argument("<id>", "the request")
    .option("--by <name>", `the person who decides to send them${BY_DEFAULT}`)
    .action(
      action(async (id: string, opts: { by?: string }) => {
        const by = await who(container(), opts.by);
        return { result: by.isErr() ? by : await reviews().send(id, { by: by.value }) };
      }),
    );

  mrs
    .command("resolve")
    .description("Close a thread at the host")
    .argument("<id>", "the request")
    .requiredOption("--thread <thread>", "the thread's id")
    .option("--by <name>", `the person who decides to close it${BY_DEFAULT}`)
    .action(
      action(async (id: string, opts: { thread: string; by?: string }) => {
        const by = await who(container(), opts.by);
        return { result: by.isErr() ? by : await reviews().resolve(id, opts.thread, { by: by.value }) };
      }),
    );
}
