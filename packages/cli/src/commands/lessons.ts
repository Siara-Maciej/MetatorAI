import { normalizePath } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";
import { positiveInt } from "../options.ts";

export function registerLessonsCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("lessons")
    .description("Lessons learned from runs (T4), each with a citation that must hold")
    .command("add")
    .description(
      "Write a lesson to docs/metator/lessons after a human approved it; the quote must be in the code",
    )
    .requiredOption("--title <text>", "short title (also the file name)")
    .requiredOption("--statement <text>", "what to do or avoid, and why")
    .requiredOption("--file <path>", "file that proves the lesson")
    .requiredOption("--line <n>", "line of the quote", positiveInt)
    .requiredOption("--quote <text>", "the quoted code")
    .option("--run <id>", "run the lesson comes from")
    .option("--tag <tags...>", "tags")
    .action(
      action(
        async (opts: {
          title: string;
          statement: string;
          file: string;
          line: number;
          quote: string;
          run?: string;
          tag?: string[];
        }) => ({
          result: await container()
            .resolve("addLesson")
            .execute({
              title: opts.title,
              statement: opts.statement,
              cite: { path: normalizePath(opts.file), line: opts.line, quote: opts.quote },
              tags: opts.tag ?? [],
              ...(opts.run ? { run: opts.run } : {}),
            }),
        }),
      ),
    );
}
