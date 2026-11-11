# First run

This page sets MetatorAI up in a repository and walks one run by hand, so you see the stages, a gate and a blocked push before an agent does the work for you. It takes about ten minutes and needs the [`metator` command](./install.md).

Every `metator` command prints one JSON object. The examples show it trimmed.

## Set up the repository

Run this in the root of a git repository:

```bash
metator setup
```

In a terminal it asks which AI tools you use, which workflows to install and whether to install the hooks. To skip the questions:

```bash
metator setup --host claude --hooks --yes
```

```json
{"ok":true,"data":{"config":"metator.config.yml","hosts":["claude"],
 "workflows":["mt-bugfix","mt-feature","mt-pr-review","mt-refactor","mt-review-response","mt-self-review","mt-system-change"],
 "hooks":true,"generated":38,"gitignore":"added",
 "checks":[{"command":"meta agents-lint","passed":true},{"command":"meta skills-lint","passed":true},
           {"command":"workflow lint","passed":true},{"command":"generate --check","passed":true}]}}
```

Setup does four things:

1. It reads your `package.json` scripts and writes `metator.config.yml` with the quality gates it found. An existing config is never overwritten.
2. It copies the shipped agents, skills and workflows into `metator/` and `.github/metator/workflows/`.
3. It generates the files your AI tool reads (`.claude/` for Claude Code, `.github/agents/` and `.github/skills/` for Copilot), and the hooks when you pass `--hooks`.
4. It lints what it installed.

Commit the result. `--host` takes `claude`, `copilot` or both.

## Check what a run can do here

```bash
metator doctor
```

```json
{"ok":true,"data":{"ready":true,"checks":[
 {"id":"gates","status":"ok","message":"gates: 3 full and 1 quick step(s)"},
 {"id":"dependencies","status":"warn","message":"dependencies are not installed: in a run, tests, the type checker and linters cannot run, so gates check only rules","fix":"npm install"},
 {"id":"remote","status":"warn","message":"no git remote: a run's publish stage cannot push its branch","fix":"git remote add origin <url>"}]}}
```

Each check is `ok`, `warn` (a run starts but does less) or `fail` (a run cannot start). Each problem names the command that fixes it.

## Run the quality gate

```bash
metator gate full
```

```json
{"ok":true,"data":{"gate":"full","passed":true,"steps":[
 {"id":"lint","command":["npm","run","lint"],"exitCode":0,"status":"pass"},
 {"id":"typecheck","command":["npm","run","typecheck"],"exitCode":0,"status":"pass"},
 {"id":"test","command":["npm","run","test"],"exitCode":0,"status":"pass"}]}}
```

These are your own scripts, run with your package manager. Agents run the same command during a run, and the report is saved to `.metator/gates/full.json`. To change the steps, edit `gates` in `metator.config.yml` (see [Gates and CI](../repo/gates-ci.md)).

## Walk a run by hand

In daily use an agent sends these commands. Sending them yourself shows what the agent is allowed to do.

Start a run of the feature workflow:

```bash
metator run init --workflow mt-feature --task "Add a subtract function next to add, with a test"
```

```json
{"ok":true,"data":{"runId":"20261111-mt-feature-add-a-subtract-function-next-to-add-with",
 "stage":"setup","status":"active","expects":["PASS","FAIL","ABORT"]}}
```

The run is at its first stage. Report four stages as done, one command each:

```bash
metator run advance pass
```

The run moves through `intake`, `context`, `plan` and `plan-gate` and arrives at `plan-approval`. Send `pass` again:

```json
{"ok":false,"error":{"code":"TRANSITION_DENIED",
 "message":"Stage \"plan-approval\" (active) does not accept PASS",
 "hint":"This gate needs a human decision: APPROVE, FAIL, ABORT."}}
```

This stage accepts only an approval with a name on it:

```bash
metator run approve plan-approval --by alice
```

The run is now at `build`. With the hooks installed, your AI tool asks MetatorAI before every tool call. Ask the same question an agent's `git push` would trigger:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | metator guard pre-tool
```

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"push needs the user's approval: show the report and options, then `metator run approve push --by <user>`."}}
```

The push is denied until the run reaches its `delivery` stage and you approve it. End the demo run:

```bash
metator run close --aborted --reason "demo finished"
```

The run's directory, `.metator/runs/<run id>/`, keeps `state.json`, `log.md` with every transition, and `summary.json`.

## Start a real task

In Claude Code or Copilot Chat, ask the coordinator agent:

```text
@mt-orchestrator run mt-feature for "Add a subtract function next to add, with a test"
```

Or run `metator run` in a terminal. It asks for the workflow, the task and the AI tool, then drives the run and stops at each decision that is yours. [Start a task](../use/index.md) covers both ways.

## Update the shipped files

After you [update MetatorAI](./install.md#update), take the newer agents, skills and workflows into the repository:

```bash
metator agents update --dry-run      # what would change
metator agents update                # apply; files you changed are kept
```

A file that both you and the new version changed is reported as a conflict and your version stays. `--theirs` takes the shipped version instead.

## Next

- [Runs and workflows](./runs.md): what the stages are and what a run leaves on disk.
- [Gates and approvals](./gates.md): where a run stops and who can open each gate.
- [Rules](../repo/index.md): turn your team's conventions into checks.
