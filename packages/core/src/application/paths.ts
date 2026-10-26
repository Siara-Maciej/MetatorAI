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
