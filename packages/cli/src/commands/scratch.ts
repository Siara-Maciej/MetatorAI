import { err, MetatorError } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { byOption } from "../options.ts";
import { asPerson } from "../who.ts";

/**
 * `scratch` (ADR-0093): changes not meant for a commit (debug output, a temporary switch).
 * `begin` and `end` around a direct edit record it as a patch under `.metator/scratch/`; `list`
 * shows what is still in the working tree; `drop` takes it out again. A commit that would hold a
 * recorded change is stopped by the commit guard.
 */
export function registerScratchCommands(program: Command, { action, container }: CommandContext): void {
  const scratch = program
    .command("scratch")
    .description(
      "Changes not meant for a commit (debug output, experiments): record a direct edit, list what is still there, take it out again",
    );

  scratch
    .command("begin")
    .description("Before a direct edit not meant for a commit: remember the working tree as it is")
    .action(action(async () => ({ result: await container().resolve("scratch").begin() })));

  scratch
    .command("end")
    .description("After the edit: what changed since `scratch begin` is recorded as one patch")
    .option("--note <text>", 'what the change is for, e.g. "log every rounding while I look for the bug"')
    .action(
      action(async (opts: { note?: string }) => ({
        result: await container()
          .resolve("scratch")
          .end(opts.note !== undefined ? { note: opts.note } : {}),
      })),
    );

  meta(scratch.command("list"), { audience: "person" })
    .description(
      "The recorded changes: id, files that still hold them, note, when, and whether each can still be taken out as recorded",
    )
    .action(
      action(async () => ({
        result: (await container().resolve("scratch").list()).map(({ items, gone }) => ({
          items,
          ...(gone.length > 0 ? { gone } : {}),
        })),
      })),
    );

  scratch
    .command("drop")
    .description(
      "Take recorded changes out of the working tree again (the newest first); a patch that no longer applies is reported, never forced",
    )
    .option("--id <id>", "one record (repeatable)", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--all", "every record", false)
    .addOption(byOption("who removes them"))
    .action(
      action(async (opts: { id: string[]; all: boolean; by?: string }) => {
        if (opts.all === opts.id.length > 0)
          return {
            result: err(MetatorError.usage("name what to drop: --id <id> (repeatable), or --all")),
          };
        return asPerson(container(), opts.by, async (by) => ({
          result: await container()
            .resolve("scratch")
            .drop({ ...(opts.all ? {} : { ids: opts.id }), by }),
        }));
      }),
    );

  scratch
    .command("forget")
    .description(
      "Dismiss recorded changes without touching the files: for a record whose lines changed and that you dealt with by hand",
    )
    .option("--id <id>", "a record (repeatable)", (v: string, all: string[]) => [...all, v], [] as string[])
    .addOption(byOption("who forgets them"))
    .action(
      action(async (opts: { id: string[]; by?: string }) =>
        asPerson(container(), opts.by, async (by) => ({
          result: await container().resolve("scratch").forget({ ids: opts.id, by }),
        })),
      ),
    );
}
