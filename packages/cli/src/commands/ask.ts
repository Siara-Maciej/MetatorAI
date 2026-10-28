import { existsSync } from "node:fs";
import { join } from "node:path";
import { err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { person } from "../live.ts";
import { defaultHost, HOSTS } from "../sessions.ts";

/** `ask` (G3, ADR-0058): plain questions about the code, answered by mt-guide with citations. */
export function registerAskCommands(program: Command, ctx: CommandContext): void {
  const ask = program
    .command("ask")
    .description("Ask a question about the code (how it works, where it is); the answer cites path:line")
    .argument("[question...]", "the question, in your own words")
    .option("--continue", "a follow-up in the latest conversation", false)
    .option("--conversation <id>", "a follow-up in this conversation (`metator ask list`)")
    .option("--host <host>", `the AI host that answers: ${HOSTS.join(", ")}`)
    .action(
      ctx.action(
        async (words: string[], opts: { continue: boolean; conversation?: string; host?: string }) => {
          const place = where(ctx);
          const c = place.container;
          const conversations = c.resolve("conversationRepository");
          let conversation = opts.conversation;
          if (opts.continue && !conversation) {
            const all = await conversations.list();
            if (all.isErr()) return { result: all };
            conversation = all.value[0]?.id;
            if (!conversation)
              return {
                result: err(MetatorError.usage("no conversation to continue", 'Start one: metator ask "…"')),
              };
          }
          const terminal = ctx.terminal;
          const r = await c.resolve("askQuestion").execute({
            question: words.join(" "),
            ...(conversation ? { conversation } : {}),
            ...(opts.host ? { host: opts.host } : {}),
            defaultHost: defaultHost(c),
            by: person(process.env),
            cwd: place.cwd,
            projectRoot: place.projectRoot,
            where: place.where,
            // In a terminal the answer and the tools it used are shown as they arrive.
            ...(terminal
              ? {
                  onEvent: (e) => {
                    if (e.type === "text") terminal.show(e.text);
                    else if (e.type === "tool") terminal.show(`· ${e.name} ${e.summary}`);
                  },
                  ask: async (q) => {
                    const picked = await terminal.choose(
                      q.prompt,
                      q.options.map((o) => ({
                        value: o.label,
                        label: o.label,
                        ...(o.description ? { hint: o.description } : {}),
                      })),
                    );
                    return { choices: [picked ?? "Deny"] };
                  },
                }
              : {}),
          });
          if (r.isErr()) return { result: r };
          const missing = r.value.citations.filter((x) => !x.exists);
          return {
            result: ok({
              conversation: r.value.conversation.id,
              host: r.value.conversation.host,
              turn: r.value.conversation.turns.length,
              answer: r.value.answer,
              citations: r.value.citations,
            }),
            warnings: missing.map(
              (x) => `the answer cites ${x.path}:${x.line}, but there is no such file: check that claim`,
            ),
          };
        },
      ),
    );

  ask
    .command("list")
    .description("Conversations of `metator ask`, newest first")
    .action(
      ctx.action(async () => {
        const all = await where(ctx).container.resolve("conversationRepository").list();
        return {
          result: all.map((list) => ({
            conversations: list.map((x) => ({
              id: x.id,
              title: x.title,
              host: x.host,
              turns: x.turns.length,
              updatedAt: x.updatedAt,
            })),
          })),
        };
      }),
    );
}

/**
 * Where a question is asked: in a repository, the repository; in a folder of repositories, the
 * folder (its conversations live there), with the host files of its first set-up repository.
 */
function where(ctx: CommandContext) {
  const f = ctx.folder();
  if (!f) {
    const container = ctx.container();
    const root = container.resolve("root");
    return { container, cwd: root, projectRoot: root, where: "this repository" };
  }
  const withAgents = f.repos.find(
    (r) =>
      existsSync(join(r.root, ".claude/agents/mt-guide.md")) ||
      existsSync(join(r.root, ".github/agents/mt-guide.agent.md")),
  );
  return {
    container: ctx.containerAt(f.root),
    cwd: f.root,
    projectRoot: withAgents?.root ?? f.root,
    where: `the folder ${f.root}, which holds the repositories ${f.repos.map((r) => `${r.name} (${r.path})`).join(", ")}`,
  };
}
