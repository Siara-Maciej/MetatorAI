# Concepts

Seven things make MetatorAI what it is. Everything else on this site, every command and every file on disk, is built from them. Each concept has one page with the same shape: what it is, why it exists, where it lives on disk, the commands that touch it, what enforces it, one example, and where to go next.

| Concept | In one sentence | Page |
|---|---|---|
| **Run** | one task carried out as a state machine, with an audit log and artifacts on disk | [Run](./run.md) |
| **Workflow** | the YAML spec a run follows: stages, owners, artifacts, gates, loop limits | [Workflow](./workflow.md) |
| **Gate and approvals** | a point in a run that only evidence or a named person can open | [Gate and approvals](./gate.md) |
| **Canon** | your repository's knowledge, reviewed like code: rules, patterns, module cards, ADRs, the memory map | [Canon](./canon.md) |
| **Finding** | a review claim that carries evidence and is verified before it may block | [Finding](./finding.md) |
| **Host** | the AI tool that runs the agents: GitHub Copilot, Claude Code, OpenCode, with generated agents and hooks | [Host](./host.md) |
| **Session** | a worktree, a terminal, a driver and a supervisor that keeps the agent alive | [Session](./session.md) |

## How they fit together

A **host** runs agents. The agents move a **run** through the stages of a **workflow**, and at every **gate** the run waits for a check or a person. The agents read the **canon** for the files they touch and produce **findings** with evidence when they review. Each run works in its own **session**, so several can go on at once without stepping on each other.

```text
Host ──runs──► agents ──move──► Run ──follows──► Workflow
                 │                │                  │
                 │ read           │ stops at         │ declares
                 ▼                ▼                  ▼
               Canon            Gate ◄────────── approvals
                 │
                 └──cited by──► Finding          Session: worktree · terminal · driver · supervisor
```

## Two rules that hold everywhere

- **Every file is a versioned document.** It starts with `kind` and `schemaVersion`; older versions are migrated on read, newer ones are rejected with a clear message. The list is in [Documents and schemas](../reference/documents.md).
- **Every command answers with one JSON object.** `{"ok":true,"data":…}` or `{"ok":false,"error":{code,message,hint}}`, with stable exit codes. Agents never parse prose. See [CLI and envelope](../reference/cli.md).

## Next

- Start with [Run](./run.md), then [Gate and approvals](./gate.md).
- To do something now: [Work](../work/index.md).
