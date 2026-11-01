---
kind: Skill
schemaVersion: 1
name: mt-run-without-asking
description: Use when you are about to run a shell or metator command in a MetatorAI run, to pick the form that runs without asking a person (reading, searching, the change, run artifacts). Do not use to decide what the task needs; it only says how to run what you already need.
---
# When
Every stage of a run, before a Bash call. A command a person must allow stops the run until someone answers, and a guessed command only asks. Each row below was asked in real runs and answered the same way.

# Steps
1. Read and change files with Read, Edit and Write (JSON included). Find files with Glob and Grep; where your host has neither, a plain `grep -rn`, `rg`, `find <dir>`, `ls`, `cat`, `head`, `tail`, `wc`, `readlink`, `realpath` or `sed -n <a>,<b>p` runs without asking, and so does git that only reads.
2. One command per call, with paths from the repository root. These always ask, so leave them out:

| Instead of | Use |
|---|---|
| `cd dir && …`, `cd ../..`, a path with `..` | paths from the repository root; the run's worktree is where you already are |
| `$(…)`, backticks, `xargs`, a `for` loop, `\| while` | separate calls, or Grep for the list first |
| a backtick inside a grep pattern | the Grep tool for that pattern |
| `python -c`, `node -e`, `jq`, `awk` on a file | Read the file (JSON too); `sed -n <a>,<b>p` for a range |
| a script that edits `plan.json`, `merged.json` or code | Edit (one change per call) or Write the whole file |
| `mkdir -p`, `cp`, `mv`, `cat > file <<EOF`, `printf > file` | Write: it creates the directories it needs |
| `git add`, `git commit`, `git checkout`, `git stash`, `git -c …`, `git diff --output` | nothing before publish: the run commits there (after the delivery gate, `git add -A`, `git commit -m …` and `git push -u origin <branch>` run without asking for the publish agent); reading git (`status`, `log`, `show`, `diff`, `blame`, `grep`, `rev-parse`, `merge-base`, `ls-files`, `describe`, `branch --show-current`) runs without asking, also as `git -C <checkout>` |
| a large diff dug out of a tool-result file | `metator review diff --base HEAD --out <run dir>/change.diff`, then Read it |
| `find /`, `ls node_modules`, `node --version` | dependencies are not installed unless the stage says so: reason from the code |
| `curl`, `wget`, any network call | none: work from the code and the run's decisions |
| `readlink`, `realpath` outside the working directories | inside them both run without asking; `<worktree>/.metator/runs` is a link to the checkout's runs: both paths are the same files |
| `metator ask` | read the code yourself: it starts another agent |
| a metator command you think exists (`metator diff`, `metator run artifacts`, `metator run validate`, `metator gates status`, `metator review grep`) | `metator help`, and use only what it lists |
| `metator guard …` | hooks run themselves; never run one |
| a gate check of your own (`debug-tags check`, `contract diff`, a test runner) at the gates stage | `metator gate full` only: the configuration decides the checks |

3. Metator queries run without asking: `metator help`, `graph …`, `symbols find`, `similar`, `review diff|plan|metadata`, `findings schema|check-quote|validate`, `plan lint`, `run status|schema`, `api diff`, `system show|impact|sources`. A writing option (`--out`, `--write`, `--fix`) runs without asking only when your agent's definition names that command.
4. Write run artifacts with Write into the run directory the prompt names (`.metator/runs/<run id>/…`), never into a `findings/` or other folder of the repository.

# Output
No artifact: the commands you run, each in the form above.

# Checklist
- [ ] no `cd`, `..`, `$(…)`, backticks, loops or pipes into an interpreter
- [ ] files read and written with Read, Edit and Write, never through the shell
- [ ] the change seen through `metator review diff` or git that only reads; git never writes
- [ ] every metator command is one `metator help` lists

# Errors
A call was refused anyway: read the reason, pick the form from the table, and do not try the same command again. When nothing here fits and the work truly needs it, finish with `STATUS: blocked: <what you need and why>` instead of asking for the command.
