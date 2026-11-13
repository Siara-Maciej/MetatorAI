# Ports and plugins

This page is for contributors who connect a new tool to MetatorAI: a rule engine, a host, a version control system. You add an adapter in a plugin package. The workflows and the core do not change.

## Layers

The core never calls a tool directly. It defines ports, which are small TypeScript interfaces. A plugin implements a port for one concrete tool.

```text
cli  ->  runtime  ->  plugin-*  ->  core
```

| Package | Role | May import |
|---|---|---|
| `packages/core` | domain, ports and use cases; no I/O in the domain | approved libraries only |
| `packages/plugin-*` | adapters, one tool each | `@metator/core` |
| `packages/runtime` | builds the container; the only place that names concrete adapters | core and plugins |
| `packages/cli` | commands, the daemon, the terminal views | runtime |

The rules in `rules/architecture/*.yml` (ast-grep) check these directions in CI. When a rule fails, move the code. Do not weaken the rule.

Plugins are workspace packages of the MetatorAI repository, wired in `packages/runtime`. A project cannot load a plugin package of its own from its configuration.

## Ports and their adapters

The ports are in `packages/core/src/ports/index.ts`. A port has at most five members.

| Plugin | Ports it implements |
|---|---|
| `plugin-bun` | `FileSystem`, `ProcessRunner`, `BinResolver`, `MachineState`, `TreeCopier`, `DataIsolator`, `Sandbox`, `Launcher`, `Timer`, and a `RuleEngine` for conformance tests |
| `plugin-git` | `Vcs`, `RevisionReader`, `WorktreeManager`, `BranchHistory`, `BranchPublication`, `ChangeHistory`, `ChangePatch`, `RepositoryCloner` |
| `plugin-node` | `WorkspaceReader`, `PackageManagerDetector`, `PackageManager`, `ManifestReader`, `CoverageReader`, `Terminal`, `PortProbe`, `HealthProbe`, `ToolBoundariesReader` |
| `plugin-typescript` | `ImportAnalyzer`, `SymbolAnalyzer`, `DeclarationEmitter`, and a `RuleEngine` for `tsc` |
| `plugin-astgrep` | `RuleEngine`, `RuleScaffolder` |
| `plugin-biome` | `RuleEngine` |
| `plugin-host-claude`, `plugin-host-copilot` | `AgentHost`, `InteractiveHost`, `HostGenerator`, `SkillGenerator` |
| `plugin-host-opencode` | `InteractiveHost` |
| `plugin-host-scenario` | `AgentHost`, `InteractiveHost`: a scripted host for tests |
| `plugin-codehost-mcp` | `CodeHost`, `ReviewHost`: issues and review threads through an MCP server |
| `plugin-docker` | `ContainerRuntime` |
| `plugin-openapi` | `ContractDetector`, `ContractDiffer` for the `openapi` contract kind |

## A port in code

```ts
// packages/core/src/ports/index.ts
export interface RuleEngine {
  /** The `<engine>` part of `<engine>:<rule id>`. */
  readonly engine: string;
  rules(): Promise<Result<readonly EngineRule[], MetatorError>>;
  /** Runs the engine on the given repo-relative files (all files when omitted). */
  check(files?: readonly string[]): Promise<Result<readonly Diagnostic[], MetatorError>>;
}
```

Every method returns a `Result`. An adapter returns a tool's failure as a `MetatorError` value and never throws it. Where a tool can emit SARIF 2.1.0, the adapter reads its findings with `diagnosticsFromSarif`, so one parser serves many tools.

## Contract suites

A contract suite is one set of tests that every adapter of a port must pass, the in-memory fake included. The suites are in `packages/testing/src/contracts`: file system, file lock, process runner, worktree manager, machine state, tree copier, data isolator, version control, rule engine, agent host, interactive host, host generator, skill generator, code host, review host and contract differ.

```ts
// packages/plugin-bun/test/bun-process-runner.test.ts
import { processRunnerContract } from "@metator/testing";

processRunnerContract("BunProcessRunner", () => new BunProcessRunner());
```

Rule `MT-TEST-002` fails CI when an adapter does not run the suite of its port.

## Add an adapter

1. Find the port in `packages/core/src/ports/index.ts`. If none fits, propose a new one in an architecture decision record. Keep it to five members or fewer.
2. Create `packages/plugin-<tool>/` with the adapter. Test it against the real tool in a temporary directory.
3. If the port has a contract suite, call it from the adapter's test.
4. Register the adapter in `packages/runtime/src/bootstrap.ts`.
5. List every new third-party package in `docs/metator/dependencies.yml`. CI fails otherwise.
6. Add a mutant to `scripts/mutants.ts` for every module with behavior.
7. Run `bun run check`.

## Contract kinds

The contracts in a [system map](../repo/systems.md) work the same way. A plugin registers a kind with a detector and a compatibility check. `plugin-openapi` provides `openapi`. Another kind is another plugin, with no change to the map's schema.
