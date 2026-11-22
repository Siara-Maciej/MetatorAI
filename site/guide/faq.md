# FAQ

Short answers to the questions people ask before they try MetatorAI, each with the page that has the detail.

## Is MetatorAI an AI coding agent

No. It has no model of its own and writes no code. Claude Code or GitHub Copilot CLI does the work. MetatorAI gives that work stages, checks each stage with a command, and stops where a person decides. See [What MetatorAI is](./index.md).

## Which AI tools does it work with

Claude Code and GitHub Copilot CLI. The agents, skills and hooks are written once under `metator/` and generated for each. The app starts the command-line program (`claude` or `copilot`), so Copilot Chat in an IDE alone is not enough. See [Copilot and Claude Code](./hosts.md).

## Can I use it across several repositories

Yes. Each repository is set up on its own, and one daemon started in the folder that holds them shows all of their work in one app. A change that crosses applications becomes a system plan with one step per repository. See [Start with many repositories](./many.md).

## Which languages and package managers

The import graph and the pattern index cover JavaScript and TypeScript, in npm, pnpm, Yarn and Bun projects, including workspaces. The quality gates run your own scripts, whatever they call. Rules are enforced with ast-grep, Biome or the TypeScript compiler.

## What does it change in my repository

`metator setup` adds `metator.config.yml`, the agents and skills in `metator/`, the workflow specs in `.github/metator/workflows/`, and the generated files for your AI tool (`.claude/`, `.github/agents/`, `.github/skills/`, `.github/hooks/`). You commit all of it. Run state goes to `.metator/`, which setup adds to `.gitignore`.

## Does it send my code anywhere

The commands that analyze your code (the graph, the rules, the gates, the run state) read and write local files. What the model sees is decided by your AI tool, under that tool's data policy. A few commands talk to your code host when you run them, for example to read issues or post review replies. See [Security](../reference/security.md).

## Can an agent commit, push or comment on a pull request by itself

No, as long as the hooks are installed. A `git commit`, `push`, `merge` or `rebase` runs only with your consent: a click on the host's approval prompt (its card on Home), or your own words in the chat ("commit it"). Inside a run, approving its delivery is that consent. Inside a run, creating a pull request or commenting on one needs the run's approval; outside a run your host's own prompt asks you. A review is published only after your **Yes**. Commands such as `git push --force` and `git reset --hard` never run. See [Approvals and consent](../use/approvals.md).

## What happens when an agent gets stuck

A failed check sends the run back to an earlier stage, a limited number of times. After that the run is escalated: it stops and waits for you. Fix the cause and click **Resume** on its card (`metator run resume --by <name> --drive`), or close it with **Close run…** (`metator run close --aborted --reason <why>`). See [Full runs](../use/runs.md#how-a-run-moves).

## Do I have to approve every step

No. A question or a debug edit needs nothing. A quick change has no plan: you look at its diff and say **Fine**, and nothing is committed. A full run asks you twice, for the plan and the delivery; with `--autonomy L1` the plan approval is passed for you and logged as such, and the delivery always asks. See [Approvals and consent](../use/approvals.md#autonomy).

## Can I trust the review comments

A review finding has to quote code that exists, and `metator findings check-quote` checks the quote. A separate verifier agent then tries to refute each finding before a judge decides which ones reach you. See [Review a change](../use/review.md).

## How do I write a rule

Run `metator rules scaffold <id>`. It writes the skeleton of a tool rule and a failing test for it. See [Rules](../repo/index.md).

## Is it ready for production

Not yet. It is installed from a checkout and is not published to npm, and commands and file formats can still change. Every file MetatorAI writes carries a `kind` and a `schemaVersion`, and older files are migrated when they are read. See [Changelog](../reference/changelog.md).

## Where do I look when a command fails

Every failure is one JSON object with a `code`, a `message` and usually a `hint` that names the next command. Start with `metator doctor`, then [Troubleshooting](../reference/troubleshooting.md).
