# Modules

Modules extend the core for situations the core does not need to know about. You can run every workflow, every review and every session without them. Each module page says at the top when you do not need it.

| Module | Use it when | Page |
|---|---|---|
| **Several repositories** | you keep several independent repositories on one machine and want one place for all their sessions and questions | [Several repositories](./repositories.md) |
| **Systems of many applications** | a change touches several applications that talk through contracts, and the order of deployment matters | [Systems of many applications](./systems.md) |
| **Package architecture** | a monorepo's package graph has cycles or unclear boundaries and you want to plan a refactor with evidence | [Package architecture](./architecture.md) |
| **Start the application** | an agent's work must be checked against a running application, with its database and services | [Start the application](./environments.md) |
| **Runs in worktrees** | several runs change the same repository at once | [Runs in worktrees](./worktrees.md) |

## How a module relates to the core

A module adds commands, documents and sometimes an agent, but it never changes how a [run](../concepts/run.md) moves or what a [gate](../concepts/gate.md) accepts. A system change, for example, is a parent run with children in other repositories: each child is an ordinary run, and the parent only orders them. Package architecture adds a check to the gates and a planner that proposes moves; the moves are carried out by ordinary refactor runs.
