# FAQ

Short answers to the questions people ask before they try MetatorAI, each with the page that has the detail.

## Is MetatorAI an AI coding agent

No. It has no model of its own and writes no code. GitHub Copilot or Claude Code does the work. MetatorAI gives that work stages, checks each stage with a command, and stops where a person decides. See [What MetatorAI is](./index.md).

## Which AI tools does it work with

GitHub Copilot and Claude Code. The agents, skills and hooks are written once under `metator/` and generated for each. See [Copilot and Claude Code](./hosts.md).

## Which languages and package managers

The import graph and the pattern index cover JavaScript and TypeScript, in npm, pnpm, Yarn and Bun projects, including workspaces. The quality gates run your own scripts, whatever they call. Rules are enforced with ast-grep, Biome or the TypeScript compiler.

## What does it change in my repository

`metator setup` adds `metator.config.yml`, the agents and skills in `metator/`, the workflow specs in `.github/metator/workflows/`, and the generated files for your AI tool (`.claude/`, `.github/agents/`, `.github/skills/`, `.github/hooks/`). You commit all of it. Run state goes to `.metator/`, which setup adds to `.gitignore`.

## Does it send my code anywhere

The commands that analyze your code (the graph, the rules, the gates, the run state) read and write local files. What the model sees is decided by your AI tool, under that tool's data policy. A few commands talk to your code host when you run them, for example to read issues or post review replies. See [Security](../reference/security.md).

## Can an agent push or comment on a pull request by itself

No, as long as the hooks are installed. The pre-tool hook denies a push, a pull request and a pull request comment until a named person has approved it in the run. No autonomy level removes that approval. See [Gates and approvals](./gates.md#push-and-comments).

## What happens when an agent gets stuck

A failed check sends the run back to an earlier stage, a limited number of times. After that the run is escalated: it stops and waits for you. Fix the cause and run `metator run resume --by <name> --drive`, or close the run with `metator run close --aborted --reason <why>`. See [Runs and workflows](./runs.md#how-a-run-moves).

## Do I have to approve every step

No. You approve the plan and the delivery. With `--autonomy L1` the plan approval is passed for you and logged as such. The delivery always asks. See [Gates and approvals](./gates.md#autonomy).

## Can I trust the review comments

A review finding has to quote code that exists, and `metator findings check-quote` checks the quote. A separate verifier agent then tries to refute each finding before a judge decides which ones reach you. See [Review a change](../use/review.md).

## How do I write a rule

Run `metator rules scaffold <id>`. It writes the skeleton of a tool rule and a failing test for it. See [Rules](../repo/index.md).

## Is it ready for production

Not yet. It is installed from a checkout and is not published to npm, and commands and file formats can still change. Every file MetatorAI writes carries a `kind` and a `schemaVersion`, and older files are migrated when they are read. See [Changelog](../reference/changelog.md).

## Where do I look when a command fails

Every failure is one JSON object with a `code`, a `message` and usually a `hint` that names the next command. Start with `metator doctor`, then [Troubleshooting](../reference/troubleshooting.md).
