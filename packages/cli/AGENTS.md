# @metator/cli

The driving adapter on commander. It talks to use cases only through the runtime container.

- `src/commands/*.ts`: one module per command group, exported as `register*(program, ctx)`; register it in `src/program.ts`.
- `src/program.ts` sets commander up for JSON output; `src/run.ts` builds the envelope and the exit code (MT-CODE-004).
- Validate values with commander (`Option.choices`, `Argument.choices`, `requiredOption`, an `argParser` from `src/options.ts`), not by hand.
- A new leaf command needs a literal argv in an e2e test (MT-TEST-001) and its line in the help list of `e2e/cli.e2e.test.ts`.
