# FAQ

## Is MetatorAI another AI coding agent?

No. It does not write code and it does not replace Copilot, Claude Code or OpenCode. It runs **around** them: it measures facts about your code, hands the agents only the knowledge for the files they touch, enforces the rules through hooks the host runs, and stops at the decisions that belong to a person.

## What does it change in my repository?

A config file (`metator.config.yml`), the canon in `docs/metator/` and `metator/`, workflow specs in `.github/metator/workflows/`, and the generated host files (`.claude/`, `.github/agents`, `.github/hooks`). Everything is committed and reviewed like code. Run state lives in `.metator/`, which is git-ignored.

## Does it send my code anywhere?

The CLI itself sends nothing anywhere. It runs locally or in your CI runner. Your AI host's own data policy applies to the chat.

## Which AI hosts work?

GitHub Copilot (Copilot Chat, Copilot CLI, coding agent) and Claude Code today; OpenCode next. The agents, skills and hooks are written once and generated for each host. See [Host](../concepts/host.md).

## Which languages and tools?

The import graph and the pattern index cover JavaScript and TypeScript (npm, pnpm, Yarn and Bun projects, including workspaces). Gates run **your** scripts, whatever they are. Rules can be enforced with ast-grep, Biome, tsc or a conformance test.

## Can an agent push, merge or comment on a PR by itself?

No. Push, PR creation and PR comments need `metator run approve` by a named person, at every autonomy level. The hook denies them otherwise. See [Gate and approvals](../concepts/gate.md).

## What happens when an agent gets stuck?

A failed gate loops back to the stage the workflow names, a bounded number of times. Then the run is escalated: it stops and waits for you with the open problems and options. In a session, the supervisor also restarts a host process that died and notices one that went idle. See [Sessions and terminals](../work/sessions.md).

## Can I trust the review comments?

A blocking finding must carry a quote that exists in the code, a trigger and a path from a real caller. An independent verifier on another model tries to refute it before it reaches you. Review quality is measured on a golden set, and a change that makes it worse fails CI. See [Finding](../concepts/finding.md).

## How do I write a rule?

Start with `metator rules scaffold <id>`: it writes a rule file and an ast-grep rule with a failing test. See [Write and enforce rules](../knowledge/rules.md).

## Is it production-ready?

It is pre-alpha. The CLI, the workflow engine, the hooks, the review core and the knowledge tools are implemented and tested; it is installed from a checkout and not yet published to npm. Commands and file formats may still change; every file carries a version, so older files are migrated when read.

## Where do I go when something fails?

Every error carries a `code`, a `message` and usually a `hint` with the next step. Then [Troubleshooting](../reference/troubleshooting.md).
