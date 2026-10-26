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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test, not a template
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
    file: "packages/core/src/application/memory.ts",
    from: "if (covering.length === 0) {",
    to: "if (false) {",
    why: "every knowledge file must be covered by the memory map",
  },
  {
    file: "packages/core/src/application/memory.ts",
    from: "const exceeded = item.budget ? overBudget(size, item.budget) : [];",
    to: "const exceeded: string[] = [];",
    why: "per-file context budgets are enforced",
  },
  {
    file: "packages/core/src/application/memory.ts",
    from: "over: budget ? overBudget(size, budget) : []",
    to: "over: []",
    why: "tier budgets (e.g. everything always loaded) are enforced",
  },
  {
    file: "packages/core/src/application/memory.ts",
    from: "if (input.fix) updated = updated.replace(",
    to: "if (false) updated = updated.replace(",
    why: "validate --fix rewrites the line of a moved quote",
  },
  {
    file: "packages/core/src/domain/memory.ts",
    from: "const scanned = options.markdown ? maskMarkdownCode(text) : text;",
    to: "const scanned = text;",
    why: "example citations in Markdown code are not claims",
  },
  {
    file: "packages/core/src/domain/memory.ts",
    from: "    from(l).includes(q) &&\n",
    to: "    true &&\n",
    why: "a citation is true only if the quote is really there",
  },
  {
    file: "packages/core/src/application/cards.ts",
    from: "next = renderCard({ ...parts.value, package: pkg.name, dir: pkg.dir, generated });",
    to: "next = renderCard({ package: pkg.name, dir: pkg.dir, generated, ...cardSkeleton(pkg.name) });",
    why: "cards build never overwrites curated sections",
  },
  {
    file: "packages/core/src/application/cards.ts",
    from: "(isTest(e.from) ? testDependsOn : dependsOn).add(to)",
    to: "dependsOn.add(to)",
    why: "test-only imports are not package dependencies",
  },
  {
    file: "packages/core/src/application/cards.ts",
    from: "if (input.check) {",
    to: "if (false) {",
    why: "cards build --check compares and never writes",
  },
  {
    file: "packages/core/src/application/patterns.ts",
    from: "const occurrences = all.filter((o) => !legacyPaths.has(o.file));",
    to: "const occurrences = all;",
    why: "legacy files are never offered as examples",
  },
  {
    file: "packages/core/src/application/patterns.ts",
    from: "else if (!occurrences.some((o) => o.file === p.exemplar)) {",
    to: "else if (false) {",
    why: "a pattern's exemplar must be a real occurrence",
  },
  {
    file: "packages/core/src/application/patterns.ts",
    from: "if (occurrences.length < p.minOccurrences) {",
    to: "if (false) {",
    why: "a pattern needs enough occurrences to be a pattern",
  },
  {
    file: "packages/core/src/application/rules.ts",
    from: 'diagnostics.value.filter((x) => x.severity !== "info")',
    to: "diagnostics.value",
    why: "pattern hints are not rule violations",
  },
  {
    file: "packages/core/src/application/adrs.ts",
    from: 'if (adr.status === "Accepted") {',
    to: "if (false) {",
    why: "an Accepted ADR names the canon rules it implies",
  },
  {
    file: "packages/core/src/application/adrs.ts",
    from: "for (const id of adr.ruleRefs) if (!canon.has(id))",
    to: "for (const id of adr.ruleRefs) if (false)",
    why: "ADRs reference only rules that exist",
  },
  {
    file: "packages/core/src/application/adrs.ts",
    from: "else if (adr.status && !row.toLowerCase().includes(adr.status.toLowerCase())) {",
    to: "else if (false) {",
    why: "the ADR index shows each ADR's current status",
  },
  {
    file: "packages/core/src/application/rules.ts",
    from: "e1Percent: rules.length === 0 ? 0 : Math.round((E1 / rules.length) * 100),",
    to: "e1Percent: 100,",
    why: "rules coverage measures the real E1 share",
  },
  {
    file: "packages/core/src/application/rules.ts",
    from: "if (rule.implementation) {\n      return err(MetatorError.usage(",
    to: "if (false) {\n      return err(MetatorError.usage(",
    why: "scaffold never replaces an existing E1 implementation",
  },
  {
    file: "packages/plugin-astgrep/src/ast-grep-scaffolder.ts",
    from: "if (existsSync(join(this.root, f)))",
    to: "if (false)",
    why: "scaffold never overwrites an existing tool rule",
  },
  {
    file: "packages/core/src/domain/sarif.ts",
    from: "return path.startsWith(base) ? path.slice(base.length) : path;",
    to: "return path;",
    why: "SARIF paths become repo-relative so findings map to files and rules",
  },
  {
    file: "packages/plugin-biome/src/biome-engine.ts",
    from: "if (!CONFIG_FILES.some((f) => existsSync(join(this.root, f)))) return ok([]);",
    to: "",
    why: "Biome never runs its defaults in a repo that does not use Biome",
  },
  {
    file: "packages/core/src/domain/dupes.ts",
    from: "if (similarity < threshold) continue;",
    to: "",
    why: "near duplicates respect the similarity threshold",
  },
  {
    file: "packages/core/src/application/memory.ts",
    from: 'if (itemFor(map, file)?.kind === "derived") continue;',
    to: "",
    why: "generated copies are not reported as duplicates",
  },
  {
    file: "packages/core/src/application/rules.ts",
    from: "else if (found.enabled === false)",
    to: "else if (false)",
    why: "an E1 rule bound to a tool rule that is turned off is not enforced",
  },
  {
    file: "packages/core/src/application/rules.ts",
    from: "const used = this.engines.filter((e) =>\n      [...canon.keys()].some((k) => parseImplementation(k).engine === e.engine),\n    );",
    to: "const used = this.engines;",
    why: "rules check runs only the engines the canon binds rules to",
  },
  {
    file: "packages/plugin-typescript/src/tsc-engine.ts",
    from: "(STRICT_FAMILY.includes(name) && options.strict === true && options[name] !== false)",
    to: "false",
    why: "strict turns on its family of checks unless one is set to false",
  },
  {
    file: "packages/plugin-biome/src/biome-engine.ts",
    from: "const marked = enabled ? rules.map((r) => ({ ...r, enabled: enabled.has(r.id) })) : rules;",
    to: "const marked = rules;",
    why: "Biome rules say whether the repo's config turns them on",
  },
  {
    file: "packages/core/src/domain/discovery.ts",
    from: 'const target = rest.find((a) => !a.startsWith("-"));',
    to: "const target = undefined as string | undefined;",
    why: "a script that already names a target is not file-scopable",
  },
  {
    file: "packages/core/src/domain/discovery.ts",
    from: "if (!byName && !GENERIC_NAMES.test(name) && SIGNALS.some((o) => o !== s && o.name.test(name))) continue;",
    to: "",
    why: "a specific script name wins over another capability's command signal",
  },
  {
    file: "packages/core/src/application/discover.ts",
    from: "if ((pm.value?.lockfiles.length ?? 0) > 1) {",
    to: "if (false) {",
    why: "several lockfiles are reported",
  },
  {
    file: "packages/core/src/application/gate.ts",
    from: "if (step.okExitCodes.includes(r.exitCode))",
    to: "if (true)",
    why: "a failing gate step fails the gate",
  },
  {
    file: "packages/core/src/application/gate.ts",
    from: "const matched = files && step.match ? files.filter((f) => matchesAny(f, step.match ?? [])) : files;",
    to: "const matched = files;",
    why: "a step only receives the files it checks",
  },
  {
    file: "packages/core/src/application/init.ts",
    from: "if (!input.dryRun && (await this.fs.exists(file)))",
    to: "if (false)",
    why: "init never overwrites an existing config",
  },
  {
    file: "packages/plugin-host-claude/src/claude-generator.ts",
    from: 'read: ["Read", "Glob"],',
    to: 'read: ["ReadFile"],',
    why: "Claude Code tool names are pinned by a snapshot",
  },
  {
    file: "packages/plugin-host-copilot/src/copilot-generator.ts",
    from: '"user-invocable": userInvocable(agent),',
    to: '"user-invocable": true,',
    why: "Copilot workers stay out of the user's agent picker",
  },
  {
    file: "packages/core/src/application/agents.ts",
    from: "for (const cycle of graph.cycles()) {",
    to: "for (const cycle of [] as string[][]) {",
    why: "delegation cycles are errors",
  },
  {
    file: "packages/core/src/application/agents.ts",
    from: "else if (input.check) stale.push(path);",
    to: "else if (false) stale.push(path);",
    why: "generate --check compares and never writes",
  },
  {
    file: "packages/core/src/application/findings.ts",
    from: 'if (match.status === "stale") reasons.push(',
    to: "if (false) reasons.push(",
    why: "a finding whose quote is not in the code never reaches Verify",
  },
  {
    file: "packages/core/src/domain/finding.ts",
    from: 'if (f.severity === "blocking") {',
    to: "if (false) {",
    why: "a blocking finding must carry trigger, reachability and evidence",
  },
  {
    file: "packages/core/src/domain/finding.ts",
    from: "return common / (wa.size + wb.size - common || 1) >= 0.5;",
    to: "return false;",
    why: "the same root cause from two lenses is merged",
  },
  {
    file: "packages/core/src/domain/verdict.ts",
    from: 'const blocking = live.filter((f) => f.severity === "blocking" && f.verification?.status === "confirmed");',
    to: 'const blocking = live.filter((f) => f.severity === "blocking");',
    why: "only confirmed blockers block a change",
  },
  {
    file: "packages/core/src/domain/verdict.ts",
    from: "const comments = verdict.blocking.map(",
    to: "const comments = [...verdict.blocking, ...verdict.consider].map(",
    why: "inline comments only for confirmed blockers, the rest in the summary",
  },
  {
    file: "packages/core/src/domain/agent.ts",
    from: "return body.replace(PARTIAL, (whole, name: string) => partials.get(name)?.trimEnd() ?? whole);",
    to: "return body;",
    why: "partials are expanded into the agents hosts receive",
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
