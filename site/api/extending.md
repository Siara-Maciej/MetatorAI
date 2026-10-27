# Extending: ports and plugins

MetatorAI never calls a tool directly from its core. The core defines **ports**: small TypeScript interfaces with at most five members. **Plugins** implement them for a concrete tool. Adding a tool is a new adapter, not a change to the workflows.

```text
   cli ──► runtime (the only place that knows adapters) ──► plugin-* (adapters)
                     │                                          │ implements
                     ▼                                          ▼
                 core: application (use cases) ──► ports (interfaces) ◄── domain (pure)
```

`rules/architecture/*.yml` (ast-grep) enforces the direction in CI: the domain has no I/O, plugins import only `@metator/core`, and only the runtime names concrete adapters.

::: info Status
Today plugins are workspace packages of the MetatorAI repository, wired in `packages/runtime`. Loading external plugin packages from a project's configuration is planned.
:::

## Ports

| Port | What it abstracts | Adapters today |
|---|---|---|
| `ReadonlyFileSystem`, `FileSystem` | read, write, glob repository files | Bun (`plugin-bun`) |
| `ProcessRunner` | run a command with a timeout | Bun |
| `BinResolver` | find a binary in `node_modules/.bin` | `plugin-bun` |
| `Clock`, `Logger` | time and diagnostics | runtime |
| `Vcs` | changed files, file list, remote | git via simple-git (`plugin-git`) |
| `RevisionReader` | files at the merge base, added lines, last change per file | git |
| `WorkspaceReader` | workspace packages | manypkg (`plugin-node`) |
| `PackageManagerDetector`, `PackageManager` | which package manager, how to run a script | package-manager-detector |
| `CoverageReader` | line coverage | LCOV |
| `ImportAnalyzer` | imports of a file and how they resolve | oxc (`plugin-typescript`) |
| `SymbolAnalyzer` | exports, re-exports and imports by name | oxc |
| `DeclarationEmitter` | declaration files for API snapshots | `tsc --emitDeclarationOnly` |
| `ImportGraphReader` | the import graph | the import index |
| `RuleEngine` | tool rules and their findings | ast-grep, Biome (SARIF), tsc, conformance tests |
| `RuleScaffolder` | a new tool rule with a failing test | ast-grep |
| `HostGenerator`, `SkillGenerator` | agents, skills and hooks for an AI host | Claude Code, GitHub Copilot |

## A port in code

```ts
// packages/core/src/ports/index.ts
export interface RuleEngine {
  readonly engine: string;                              // e.g. "ast-grep", the prefix in `implementation: ast-grep:<rule>`
  rules(): Promise<Result<readonly EngineRule[], MetatorError>>;
  check(files?: readonly string[]): Promise<Result<readonly Diagnostic[], MetatorError>>;
}
```

Every method returns a `Result` (neverthrow): adapters return tool errors as `MetatorError` values, never by throwing. Tool findings come in as SARIF 2.1.0 where the tool can emit it (`diagnosticsFromSarif`), so one parser serves many tools.

## Contract suites

A port with a contract suite in `packages/testing/src/contracts` (today: `FileSystem` and `ProcessRunner`) is tested the same way for every adapter, including the in-memory fake. This keeps a Bun adapter and a test fake interchangeable; rule MT-TEST-002 fails CI when an adapter does not run its suite.

```ts
import { fileSystemContract } from "@metator/testing";
// packages/plugin-bun/test/bun-file-system.test.ts
fileSystemContract("BunFileSystem", seeded);   // seeded(files) writes the files into a temp dir and returns the adapter
```

## Add an adapter

1. Find the port in `packages/core/src/ports/index.ts`; if none fits, propose one in an ADR (ports stay small: at most five members).
2. Create `packages/plugin-<tool>/` with the adapter and tests against the **real** tool in a temp directory.
3. If the port has a contract suite in `@metator/testing`, call it from the adapter's test.
4. Register the adapter in `packages/runtime/src/bootstrap.ts`.
5. List any new third-party package in `docs/metator/dependencies.yml` with its ADR; CI fails otherwise.
6. Add a mutant to `scripts/mutants.ts` for every module with behavior.

## Contract kinds for systems

The system map's contract kinds come from the same mechanism: a plugin registers a kind (MVP: `openapi`), and later its detector and its compatibility checker. A new kind such as AsyncAPI is a new plugin, not a schema change. See [Multi-repo](../multi-repo/index.md).
