# Quick start

A 15-minute tour on your own repository. Every command prints one JSON object; the examples below show the interesting part of it. All commands come from a real session on a small Bun workspace with two packages, `@shop/money` and `@shop/billing`.

## 1. Survey the repository and write the config

```bash
metator init --dry-run      # show the proposal, write nothing
metator init                # write metator.config.yml
```

**What it does:** detects the package manager, workspaces, scripts, linters, test runners and CI. It then proposes quality gates, each with the evidence behind it:

```json
{"capability":"test","gate":"full","step":"script test",
 "evidence":["package.json#scripts.test"],"reason":"the project's own test script (confidence 0.95)"}
```

**Why:** MetatorAI never assumes your tools. It runs **your** `lint`, `typecheck` and `test` scripts, chosen from evidence you can check. `init` never overwrites an existing config.

## 2. Install the agents, skills and workflows

The canonical agents, skills and workflow specs ship with MetatorAI. Copy them into your repository once, then generate the host files:

```bash
cp -r ~/tools/metatorai/metator ./metator                         # agents and skills
mkdir -p .github/metator
cp -r ~/tools/metatorai/.github/metator/workflows .github/metator/  # W1-W5 workflow specs
metator generate
```

**What it does:** `generate` writes `.claude/agents/*.md`, `.github/agents/*.agent.md` and the host skills from `metator/agents` and `metator/skills`.

**Why:** you edit one canonical source and both GitHub Copilot and Claude Code get the same agents. `metator generate --check` in CI fails when someone edits a generated file by hand.

Check that what you copied is consistent:

```bash
metator meta agents-lint     # {"agents":23,"problems":[]}
metator workflow lint        # {"workflows":5,"problems":[]}
```

## 3. Ask the codebase questions

```bash
metator index build
metator graph affected --files packages/money/src/index.ts
```

```json
{"changed":["packages/money/src/index.ts"],
 "files":["packages/billing/src/invoice.test.ts","packages/billing/src/invoice.ts","packages/money/src/index.ts"],
 "tests":["packages/billing/src/invoice.test.ts"]}
```

**Why:** before an agent changes `money`, it knows that `billing` and its test depend on it. With `--base main` instead of `--files`, the same command answers for everything changed on the branch.

```bash
metator graph dependents packages/money/src/index.ts --transitive   # who imports this, directly or not
metator graph cycles                                                # import cycles
metator workspace list                                              # packages of the workspace
metator cards build                                                 # one card per package: facts + your notes
```

## 4. Run the quality gate

```bash
metator gate full
```

```json
{"gate":"full","passed":true,"steps":[
  {"id":"lint","command":["bun","run","lint"],"exitCode":0,"status":"pass"},
  {"id":"typecheck","command":["bun","run","typecheck"],"exitCode":0,"status":"pass"},
  {"id":"test","command":["bun","run","test"],"exitCode":0,"status":"pass"}]}
```

**Why:** agents and CI run exactly the same checks, and the report is a file (`.metator/gates/`) the review stage can cite.

## 5. Drive a workflow run

```bash
metator run init --workflow mt-feature --task "Add combined discount"
metator run status
```

The run starts at the first stage of the feature workflow (W1) and says what it expects next (`PASS`, `FAIL` or `ABORT`). In practice the `mt-orchestrator` agent calls these commands; you can drive them by hand to see the state machine:

```bash
metator run advance pass                                         # stage done, go to the next
metator run advance fail --reason "plan lint: S2 has no exemplar" # bounded loop back to the plan
metator run approve plan-approval --by alice                     # human gates accept only an approval
```

## 6. See a guardrail work

Generate the hooks and try a push before approving it:

```bash
metator generate --hooks
echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | metator guard pre-tool
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"push needs the user's approval: show the report and options, then `metator run approve push --by <user>`."}}
```

After `metator run approve push --by alice` the same call answers `allow`. Claude Code and Copilot call this hook before every tool use, so an agent cannot push on its own.

## 7. Hand over or finish the run

```bash
metator run handoff                       # handoff.md: stage, approvals, artifacts, recent log, how to resume
metator run close --aborted --reason "demo finished"
```

`run close` writes `summary.json` with the final telemetry (duration, events, loops, approvals). It refuses to close an active run without `--aborted`, so a half-done run is never closed silently.

## Next steps

- Use the agents for real work: [Workflows](../workflows/index.md).
- Turn your conventions into checked rules: [Write and enforce rules](../how-to/rules.md).
- Run the same checks in CI: [Quality gates and CI](../how-to/gates-ci.md).
