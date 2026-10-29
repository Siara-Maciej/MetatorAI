# Quick start

A 15-minute tour on your own repository. Every command prints one JSON object; the examples below show the interesting part of it. All commands come from a real session on a small Bun workspace with two packages, `@shop/money` and `@shop/billing`.

## 1. Set MetatorAI up in one command

```bash
metator setup                                   # in a terminal: asks for hosts, workflows and hooks
metator setup --host claude --hooks --yes       # the same without questions (scripts, CI)
```

```json
{"config":"metator.config.yml","hosts":["claude"],
 "workflows":["mt-bugfix","mt-feature","mt-pr-review","mt-refactor","mt-self-review"],
 "canon":{"mode":"install","version":"0.0.0","lock":"metator/install.lock.json","steps":{"create":38}},
 "generated":31,
 "checks":[{"command":"meta agents-lint","passed":true},{"command":"meta skills-lint","passed":true},
           {"command":"workflow lint","passed":true},{"command":"generate --check","passed":true}]}
```

**What it does, in order:**
1. **Survey and config.** It detects the package manager, workspaces, scripts, linters, test runners and CI. A script that runs a task runner (`turbo lint`, `nx run-many -t test`) counts as the task it runs. A script that rewrites files (`eslint --fix`) is never a gate's check. Then it writes `metator.config.yml` with the chosen hosts and quality gates, each with the evidence behind it (`metator init --dry-run` shows the proposal alone). An existing config is never overwritten.
2. **The canon.** It copies the agents, skills and the chosen W1–W5 workflow specs shipped with MetatorAI into `metator/` and `.github/metator/workflows`. Every copied file is recorded in `metator/install.lock.json` with its content hash.
3. **Host files.** It generates `.claude/agents`, `.github/agents` and the skills for the hosts you chose, and the hooks with `--hooks`.
4. **Checks.** It lints the agents, skills and workflows and confirms the generated files are fresh, as proof the repository is ready.

**Why:** you edit one canonical source, and GitHub Copilot and Claude Code get the same agents. `metator generate --check` in CI fails when someone edits a generated file by hand. MetatorAI never assumes your tools: it runs **your** `lint`, `typecheck` and `test` scripts, chosen from evidence you can check.

## 2. Take a newer canon later

```bash
metator agents update --dry-run      # what would change
metator agents update                # take it; files you changed are kept
metator agents update --theirs       # take the canon's version where both sides changed
```

Each file gets one of these outcomes:
- `create`: the file is missing, so it is written.
- `update`: nobody here touched it, so the newer version replaces it.
- `kept`: you changed it and the canon did not, so it is left alone.
- `conflict`: both sides changed it. Your version is kept and a warning names the file; `--theirs` takes the canon's version.

**Why:** your team adapts agents to its repository; an update must not undo that silently. The lock is how MetatorAI tells "untouched" from "changed here".

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
