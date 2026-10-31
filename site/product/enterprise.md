# Security and governance

MetatorAI is built on one assumption: **an instruction in a prompt is a wish, a check in a script is a guarantee.** Everything on this page is enforced by code you can read and test, not by asking the model nicely.

## What is enforced, always

| Control | Enforced by | Applies |
|---|---|---|
| Secrets are never read or written (`.env*`, keys, `.npmrc`, `.netrc`) | `guard pre-tool` | always |
| Destructive commands are blocked (`git push --force`, `git reset --hard`, `git clean -f`, `rm -r` of a root) | `guard pre-tool` | always |
| Edits stay inside the plan (`plan-scope.json`) and inside the repository | `guard pre-tool` | during a run |
| Coordinator agents delegate and never edit code | `guard pre-tool` | during a run |
| Push, PR creation and PR comments need a human approval | `guard pre-tool` + `metator run approve` | during a run |
| A run cannot stop half-done | `guard stop` | during a run |
| Every artifact an agent writes must match its schema | `guard subagent-output` | during a run |

Hooks fail open on their own errors: a broken hook reports a system message instead of locking you out of your editor. The decisions are covered by unit and end-to-end tests, including real hook payloads.

## Human control

- **Gates you configure.** Any workflow stage can be `hitl: true`; only `metator run approve <stage> --by <name>` moves it on.
- **Gates that cannot be automated away.** A stage marked `neverSkip` waits for a person at every autonomy level.
- **External actions are separate approvals.** `push` and `comment` are approved explicitly, even in autopilot.
- **Bounded loops.** When a loop limit is reached, the run is `escalated` with the open problems and options. It never retries forever.

## Audit trail

Every run keeps:

| File | Contents |
|---|---|
| `state.json` | current stage, loops used, approvals with who and when (written only by `metator run`) |
| `log.md` | append-only: every transition, approval, autopilot switch, checkpoint and close |
| `summary.json` | final telemetry: status, duration, events per type, approvals, artifacts |
| artifacts | the plan, its scope, gate reports, findings and the verdict, each a versioned document |

```text
- 2026-10-26T22:25:16Z · setup · PASS → intake
- 2026-10-26T22:25:25Z · plan-approval · APPROVE · by maciej · choice autopilot → build
- 2026-10-26T22:25:25Z · autopilot · autonomy L1
- 2026-10-26T22:25:25Z · approved push · by maciej
- 2026-10-26T22:25:30Z · closed · aborted
```

## Least privilege for agents

Each canonical agent declares its capabilities, and the generated host files turn them into tool allowlists:

```yaml
# metator/agents/mt-scout.md (front matter)
capabilities: [read, search, "metator:graph", "metator:workspace", "metator:cards", "metator:owners"]
```

```text
# generated .claude/agents/mt-scout.md
tools: Read, Glob, Grep, Bash(metator graph:*), Bash(metator workspace:*), Bash(metator cards:*), Bash(metator owners:*)
```

A coordinator gets `Agent(<its workers>)`, never a plain `Agent`: it can start only the workers it delegates to, not a general-purpose agent with every tool its own definition withholds. Review lenses read with Read, Glob and Grep and run only their `metator` commands; the verifier gets a shell to run the test that refutes a finding.

**Searching without a person, never writing.** An agent searches through the shell where its host has no search tools. A command counts as a search only when every part of it reads: a pipeline or chain of `grep`, `rg`, `find`, `ls`, `cat`, `head`, `sed -n '<lines>p'` and similar, with no option that writes or runs something (`find -exec`, `-delete`, `rg --pre`, `sort -o`, `sed -i`), no redirection other than to `/dev/null` or `2>&1`, no substitution, and paths inside the agent's directories. MetatorAI's own queries count too (`metator symbols find`, `graph deps`, `rules show`, `run status`, `review diff`, `help`, `--help`), unless an option writes a file (`--out`, `--write`, `--fix`). Such a search runs without asking; anything else goes to a person. Files that may hold secrets are denied in-process by MetatorAI's own hook, so the denial holds even where the repository's settings do not apply.

`metator meta agents-lint` checks every delegation: the agent is known, its coordinator allows it, and there are no cycles. `metator meta audit` finds dead agents and nesting deeper than two levels.

## Trustworthy review

- A blocking finding must carry a quote that exists in the code, a trigger and the path by which it is reached; `findings validate` drops the rest.
- An independent verifier tries to refute each blocking finding; only confirmed blockers block.
- Review quality is measured on a golden set (precision, recall, false blocks, decision variance). `metator eval compare` fails CI when a change to prompts or agents makes it worse.

## Change control for the canon

| What changes | Gate in CI |
|---|---|
| Rules | `rules lint`, `rules coverage --min-e1 <n>`, generated instructions up to date |
| Agents and skills | `meta agents-lint`, `meta skills-lint`, `generate --check` |
| Workflows | `workflow validate`, `workflow lint` (16-section anatomy) |
| Knowledge | `memory check` (mapped, budgets, citations), `docs links`, `docs drift`, `cards build --check` |
| Decisions | `adr lint`; agents may only draft ADRs as `Proposed`, people accept them |

All of it runs in one command: `metator meta check-all`.

## Data handling

- MetatorAI runs locally or in your CI runner. The CLI itself sends nothing anywhere; your AI host's own data policy applies to the chat.
- Text from issues, PRs, comments and other repositories is treated as data. The agent instructions say so, and the hooks do not depend on it.
- Run state lives in `.metator/`, which is git-ignored. Canon files are committed and reviewed like code.
