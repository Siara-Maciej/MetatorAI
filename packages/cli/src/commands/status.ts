import { type Overview, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

/**
 * `metator status` (G4, ADR-0059): every run (its stages, who must act, the questions, the last
 * thing that happened, its worktree and services) and the conversations; in a folder of
 * repositories, that for each repository.
 */
export function registerStatusCommand(program: Command, ctx: CommandContext): void {
  program
    .command("status")
    .description("The work at a glance: each run's stages, who must act, questions, services; conversations")
    .action(
      ctx.action(async () => {
        const f = ctx.folder();
        if (!f) return { result: await ctx.container().resolve("workOverview").execute() };
        const repos: ({ name: string; path: string } & (Overview | { error: string }))[] = [];
        const warnings: string[] = [];
        for (const r of f.repos) {
          try {
            const o = await ctx.containerAt(r.root).resolve("workOverview").execute();
            if (o.isErr()) {
              warnings.push(`${r.name}: ${o.error.message}`);
              repos.push({ name: r.name, path: r.path, error: o.error.message });
            } else repos.push({ name: r.name, path: r.path, ...o.value });
          } catch (e) {
            warnings.push(`${r.name}: ${(e as Error).message}`);
            repos.push({ name: r.name, path: r.path, error: (e as Error).message });
          }
        }
        const folder = await ctx.containerAt(f.root).resolve("conversationRepository").list();
        const sum = (k: "you" | "driving" | "stopped" | "questions" | "services") =>
          repos.reduce((n, r) => n + ("counts" in r ? r.counts[k] : 0), 0);
        return {
          result: ok({
            folder: f.root,
            repos,
            conversations: folder.isOk()
              ? folder.value.map((c) => ({
                  id: c.id,
                  title: c.title,
                  host: c.host,
                  turns: c.turns.length,
                  updatedAt: c.updatedAt,
                }))
              : [],
            counts: {
              you: sum("you"),
              driving: sum("driving"),
              stopped: sum("stopped"),
              questions: sum("questions"),
              services: sum("services"),
            },
          }),
          warnings,
        };
      }),
    );
}
