/** Repo-relative locations used by MetatorAI (overridable through metator.config later). */
export interface MetatorPaths {
  readonly workflows: string;
  readonly runs: string;
  readonly index: string;
  readonly rules: string;
  /** Host instruction files generated from the rule canon (GitHub Copilot `applyTo` files). */
  readonly instructions: string;
  readonly memoryMap: string;
  readonly cards: string;
  readonly patterns: string;
  readonly adr: string;
  readonly discovery: string;
  readonly gates: string;
  /** Canonical agents (host-neutral sources of generated host agents). */
  readonly agents: string;
  /** The golden set of review evals. */
  readonly evals: string;
  /** Canonical skills (`<name>/SKILL.md` each). */
  readonly skills: string;
  /** API snapshots (`api snapshot`). */
  readonly api: string;
  /** Lessons learned from runs (T4, `lessons add`). */
  readonly lessons: string;
  /** Claims about the code a docs analysis verified (`docs drift`). */
  readonly claims: string;
  /** The system map: applications, contracts and policies (ADR-0047). */
  readonly system: string;
  /** What `agents install|update` wrote, with content hashes (ADR-0049). */
  readonly installLock: string;
  /** Run worktrees (`<id>/`, F8.2): the person's code on a run's branch, not MetatorAI documents. */
  readonly worktrees: string;
  /** The registry of worktrees and their port blocks. */
  readonly worktreeRegistry: string;
  /** How to start the application (`Environment`, F8.5). */
  readonly environment: string;
  /** What runs now, per place (`EnvState`). */
  readonly envState: string;
  /** What a start costs, measured by `env analyze` (`EnvProfile`, F8.7). */
  readonly envProfile: string;
  /** Conversations of `metator ask` (`Conversation`, G3). */
  readonly conversations: string;
  /** How packages may depend on each other (`ArchitecturePolicy`, H2). */
  readonly architecture: string;
  /** Architecture violations accepted for now (`ArchitectureBaseline`, H2). */
  readonly archBaseline: string;
  /** Generated architecture reports (`arch analyze`, H1). */
  readonly arch: string;
  /** Refactor plans (`RefactorPlan`, H5). */
  readonly archPlans: string;
  /** The golden set of refactor planning (`ArchEvalCase`, H7). */
  readonly archEvals: string;
  /** System plans and their analyses (`SystemPlan`, `SystemAnalysis`, F7.5). */
  readonly systemPlans: string;
  /** The golden set of system changes (`SystemEvalCase`, F7.7). */
  readonly systemEvals: string;
}

export const DEFAULT_PATHS: MetatorPaths = {
  workflows: ".github/metator/workflows",
  runs: ".metator/runs",
  index: ".metator/index",
  rules: "docs/metator/rules",
  instructions: ".github/instructions",
  memoryMap: "docs/metator/memory-map.yml",
  cards: "docs/metator/modules",
  patterns: "docs/metator/patterns",
  adr: "docs/adr",
  discovery: ".metator/discovery.json",
  gates: ".metator/gates",
  agents: "metator/agents",
  evals: "docs/metator/evals/golden",
  skills: "metator/skills",
  api: ".metator/api",
  lessons: "docs/metator/lessons",
  claims: "docs/metator/claims.json",
  system: "docs/metator/system.yml",
  installLock: "metator/install.lock.json",
  worktrees: ".metator/wt",
  worktreeRegistry: ".metator/worktrees.json",
  environment: "metator/environment.yml",
  envState: ".metator/env",
  envProfile: ".metator/env-profile.json",
  conversations: ".metator/conversations",
  architecture: "metator/architecture.yml",
  archBaseline: "metator/arch-baseline.json",
  arch: ".metator/arch",
  archPlans: "metator/arch/plans",
  archEvals: "docs/metator/evals/arch",
  systemPlans: "metator/system/plans",
  systemEvals: "docs/metator/evals/system",
};

/** Files the import graph never looks at, even when not git-ignored. */
export const DEFAULT_SOURCE_IGNORES: readonly string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  ".metator/**",
  "**/*.d.ts",
];

export const DEFAULT_TEST_GLOBS: readonly string[] = [
  "**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "**/__tests__/**",
];
