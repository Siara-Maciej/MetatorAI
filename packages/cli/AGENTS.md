# @metator/cli

The driving adapter on commander. It talks to use cases only through the runtime container.

- `src/commands/*.ts`: one module per command group, `register*(program, ctx)`, registered in `src/program.ts`. `src/run.ts` builds the envelope and the exit code (MT-CODE-004).
- Validate values with commander (`choices`, `requiredOption`, an `argParser` from `src/options.ts`), not by hand.
- Say what a command is where it is registered: `meta(cmd, { audience, reads, writesWith, readsWith, folder, check, render })` (`src/command-meta.ts`). MCP tools, folder commands, `meta check-all` and `help --for` come from it.
- Rename with `renamedOption` / `renamedCommand` (the old spelling stays, hidden), never by dropping it.
- A person's command registers a pure `render` (`src/render.ts`): text on stderr at a terminal, the JSON line on stdout, `--json` for the line alone.
- Shared: `runOption`, `RUN_ARGUMENT` + `runGiven`, `byOption` + `who()` (the one rule for who acts), `defined`, `failWhen`, `schemaCommand`, `ctx.root()`.
- A new leaf command needs a literal argv in an e2e test (MT-TEST-001) and its line in the help list of `e2e/cli.e2e.test.ts`.
- No full-screen view (ADR-0086): prompts are `@clack/prompts` in `src/terminal.ts`.
