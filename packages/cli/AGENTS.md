# @metator/cli

The driving adapter on commander. It talks to use cases only through the runtime container.

- `src/commands/*.ts`: one module per command group, exported as `register*(program, ctx)`; register it in `src/program.ts`.
- `src/program.ts` sets commander up for JSON output; `src/run.ts` builds the envelope and the exit code (MT-CODE-004).
- Validate values with commander (`Option.choices`, `Argument.choices`, `requiredOption`, an `argParser` from `src/options.ts`), not by hand.
- Name a flag as the rest of the CLI does (`--files`, `--timeout`; `FLAG_NAMES` in `src/options.ts`); rename with `renamedOption`, never by dropping the old spelling.
- A new leaf command needs a literal argv in an e2e test (MT-TEST-001) and its line in the help list of `e2e/cli.e2e.test.ts`.
- Say what a command is where it is registered: `meta(cmd, { audience, reads, writesWith, readsWith, folder, check, render })` (`src/command-meta.ts`). The MCP tools, the commands of a folder, `meta check-all`, `help --for` and the overview come from it; there is no list to update in another file.
- Rename a command with `renamedCommand` (the old words stay, hidden), never by dropping it; `test/command-meta.test.ts` lists every old spelling.
- A command for a person registers a `render` (`src/render.ts`, pure): at a terminal its text goes to stderr and stdout keeps the JSON line; `--json` leaves the text out.
- Shared options and outcomes: `runOption()`, `RUN_ARGUMENT` + `runGiven`, `baseOption`, `byOption` with `who()` (`src/who.ts`, the one rule for who acts), `defined`, `failWhen`, `schemaCommand`, `ctx.root()` / `ctx.start()`.
- There is no full-screen terminal view (ADR-0086): the desktop app is the graphical front. The prompts that remain are `@clack/prompts` in `src/terminal.ts`.
