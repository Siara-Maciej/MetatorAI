/**
 * Mutation smoke test: injects known bugs one at a time and requires the unit suite to fail.
 * A surviving mutant means tests stopped protecting that behavior. A missing pattern means
 * the code changed and the mutant list needs an update. Both fail the run.
 * Usage: bun scripts/mutation-smoke.ts
 */
import { join } from "node:path";

interface Mutant {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly why: string;
}

const MUTANTS: readonly Mutant[] = [
  {
    file: "packages/core/src/domain/graph.ts",
    from: "...(known.length > 0 ? alg.preorder(this.reversed, known) : [])",
    to: "...known",
    why: "affected() must be transitive",
  },
  {
    file: "packages/core/src/domain/glob.ts",
    from: "&& !(negatives.length > 0 && matcher(negatives)(p))",
    to: "",
    why: "negated globs must exclude",
  },
  {
    file: "packages/core/src/application/compute-affected.ts",
    from: "matchesAny(file, this.testGlobs)",
    to: "true",
    why: "only test files are selected as tests",
  },
  {
    file: "packages/runtime/src/envelope.ts",
    from: "current.data.length > 1",
    to: "current.data.length > 1_000_000",
    why: "output must respect the byte budget",
  },
  {
    file: "packages/runtime/src/container.ts",
    from: 'e.message.includes("Cyclic dependencies")',
    to: "false",
    why: "dependency cycles must be reported as such",
  },
  {
    file: "packages/core/src/domain/run-machine.ts",
    from: '(context.loops[(stage.onFail as NonNullable<StageSpec["onFail"]>).loop] ?? 0) <',
    to: '(context.loops[(stage.onFail as NonNullable<StageSpec["onFail"]>).loop] ?? 0) <=',
    why: "loop limits must be exact (no extra retry)",
  },
  {
    file: "packages/core/src/domain/run-machine.ts",
    from: "...(stage.hitl ? { APPROVE: advance } : { PASS: advance }),",
    to: "PASS: advance, APPROVE: advance,",
    why: "human gates must not accept PASS",
  },
  {
    file: "packages/core/src/domain/run-machine.ts",
    from: "if (!snapshot.can(event)) {",
    to: "if (false) {",
    why: "rejected events must be reported, not silently ignored",
  },
  {
    file: "packages/plugin-bun/src/bun-file-system.ts",
    from: 'startsWith("..")',
    to: 'startsWith("....")',
    why: "paths must not escape the repository root",
  },
  {
    file: "packages/cli/src/run.ts",
    from: "return final.result.isOk() ? 0 : exitCodeFor(final.result.error);",
    to: "return 0;",
    why: "failures must produce a non-zero exit code",
  },
  {
    file: "packages/core/src/domain/workflow-spec.ts",
    from: "if (ids.indexOf(stage.id) !== i) {",
    to: "if (false) {",
    why: "duplicate stage ids must be rejected",
  },
  {
    file: "packages/core/src/domain/workflow-spec.ts",
    from: "if (stage.onFail && !ids.includes(stage.onFail.goto)) {",
    to: "if (false) {",
    why: "loops must target existing stages",
  },
  {
    file: "packages/core/src/domain/run-record.ts",
    from: ".andThen((raw) => RunRecordDocument.parse(raw, source))",
    to: ".map((raw) => raw as RunRecord)",
    why: "state.json must be validated, never trusted",
  },
  {
    file: "packages/core/src/application/run-repository.ts",
    from: "RunPointerDocument.stamp({ runId: record.runId })",
    to: 'RunPointerDocument.stamp({ runId: "19990101-stale" })',
    why: "the latest pointer must follow the last written run",
  },
  {
    file: "packages/core/src/application/runs.ts",
    from: "for (let n = 2; await this.repo.exists(candidate); n++)",
    to: "for (let n = 2; false; n++)",
    why: "run ids must be unique (no overwriting an existing run)",
  },
  {
    file: "packages/plugin-git/src/git-vcs.ts",
    from: "[...diff, ...status.not_added]",
    to: "[...diff]",
    why: "untracked files count as changed",
  },
  {
    file: "packages/plugin-git/src/git-vcs.ts",
    from: 'diffSummary(["--no-renames", ref])',
    to: "diffSummary([ref])",
    why: "a rename counts under the old path too (its importers are affected)",
  },
  {
    file: "packages/plugin-git/src/git-vcs.ts",
    from: ".then(() => true)\n      .catch(() => false);",
    to: ".then(() => true)\n      .catch(() => true);",
    why: "a repository without commits must not be diffed against HEAD",
  },
  {
    file: "packages/core/src/application/import-graph.ts",
    from: "if (cached && cached.fingerprint === fingerprint) {",
    to: "if (cached) {",
    why: "an edited file must be parsed again, not served from the index",
  },
  {
    file: "packages/core/src/domain/import-index.ts",
    from: 'return a?.dir === b?.dir ? "internal" : "cross-package";',
    to: 'return a !== undefined && a.dir === b?.dir ? "internal" : "cross-package";',
    why: "files outside every workspace package belong to the root package",
  },
  {
    file: "packages/plugin-typescript/src/oxc-import-analyzer.ts",
    from: "for (const dyn of parsed.module.dynamicImports) {",
    to: "for (const dyn of [] as typeof parsed.module.dynamicImports) {",
    why: "dynamic imports are graph edges",
  },
  {
    file: "packages/core/src/application/rules.ts",
    from: "if (first) error(entry,",
    to: "if (false) error(entry,",
    why: "rule ids are unique across the canon",
  },
  {
    file: "packages/core/src/application/rules.ts",
    from: "else if (!found.hasTest) error(",
    to: "else if (false) error(",
    why: "an E1 rule's tool implementation must have a test",
  },
  {
    file: "packages/core/src/application/rules.ts",
    from: "return markdownAnchors(text.value).has(anchor);",
    to: "return true;",
    why: "links to a Markdown section must point at an existing heading",
  },
  {
    file: "packages/core/src/application/rules.ts",
    from: "if (tokens + cost > budget) {",
    to: "if (false) {",
    why: "the rule pack must respect the agent's token budget",
  },
  {
    file: "packages/core/src/application/rules.ts",
    from: "if (input.check) {",
    to: "if (false) {",
    why: "adapters --check compares and never writes",
  },
  {
    file: "packages/core/src/application/rules.ts",
    from: "d.toolRuleId ? canon.get(`${engine.engine}:${d.toolRuleId}`) : undefined",
    to: "undefined",
    why: "tool findings are mapped back to canon rule ids",
  },
  {
    file: "packages/core/src/domain/rule.ts",
    from: 'r.status === "active" && paths.some(',
    to: "paths.some(",
    why: "draft and deprecated rules never reach agents",
  },
  {
    file: "packages/cli/src/commands/run.ts",
    from: "if (!opts.by?.trim()) {",
    to: "if (false) {",
    why: "approvals must name who decided",
  },
  {
    file: "packages/cli/src/commands/run.ts",
    from: ".choices(AutonomySchema.options)",
    to: "",
    why: "autonomy must be one of the known levels",
  },
  {
    file: "packages/runtime/src/envelope.ts",
    from: "...(details === undefined ? {} : { details })",
    to: "",
    why: "error details must reach the agent",
  },
  {
    file: "packages/core/src/domain/versioned.ts",
    from: "if (schemaVersion > current) {",
    to: "if (false) {",
    why: "documents from a newer version must be refused",
  },
  {
    file: "packages/core/src/domain/versioned.ts",
    from: "kind, schemaVersion: current, ...(body as object)",
    to: "...(body as object)",
    why: "writers must stamp kind and schemaVersion",
  },
  {
    file: "packages/core/src/domain/versioned.ts",
    from: "for (let v = schemaVersion + 1; v <= current; v++)",
    to: "for (let v = current + 1; v <= current; v++)",
    why: "older documents must be migrated, not passed through",
  },
  {
    file: "packages/core/src/application/runs.ts",
    from: "if (logReady.isErr()) return err(logReady.error);",
    to: "",
    why: "a broken audit log must stop the state change",
  },
];

const ROOT = join(import.meta.dir, "..");
let failures = 0;

for (const mutant of MUTANTS) {
  const path = join(ROOT, mutant.file);
  const original = await Bun.file(path).text();
  if (!original.includes(mutant.from)) {
    console.error(`STALE   ${mutant.file}: pattern not found (${mutant.why})`);
    failures++;
    continue;
  }
  try {
    await Bun.write(path, original.replace(mutant.from, mutant.to));
    const proc = Bun.spawn(["bun", "test", "packages"], { cwd: ROOT, stdout: "ignore", stderr: "ignore" });
    const killed = (await proc.exited) !== 0;
    console.log(`${killed ? "KILLED " : "SURVIVED"} ${mutant.file}: ${mutant.why}`);
    if (!killed) failures++;
  } finally {
    await Bun.write(path, original);
  }
}

if (failures > 0) {
  console.error(`\n${failures} mutant(s) survived or are stale: strengthen the tests or update the list.`);
  process.exit(1);
}
console.log(`\nAll ${MUTANTS.length} mutants killed.`);
