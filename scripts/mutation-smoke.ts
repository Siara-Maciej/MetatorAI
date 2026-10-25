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
    from: "if (parsed.success) return ok(parsed.data);",
    to: "return ok(raw as never);",
    why: "state.json must be validated, never trusted",
  },
  {
    file: "packages/core/src/application/run-repository.ts",
    from: "/latest`, `",
    to: "/not-latest`, `",
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
    from: "...diff.value, ...untracked.value",
    to: "...diff.value",
    why: "untracked files count as changed",
  },
  {
    file: "packages/cli/src/run.ts",
    from: "if (!opts.by?.trim()) {",
    to: "if (false) {",
    why: "approvals must name who decided",
  },
  {
    file: "packages/runtime/src/envelope.ts",
    from: "...(details === undefined ? {} : { details })",
    to: "",
    why: "error details must reach the agent",
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
