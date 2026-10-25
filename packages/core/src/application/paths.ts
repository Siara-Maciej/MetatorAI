/** Repo-relative locations used by the workflow engine (overridable through metator.config later). */
export interface MetatorPaths {
  readonly workflows: string;
  readonly runs: string;
}

export const DEFAULT_PATHS: MetatorPaths = {
  workflows: ".github/metator/workflows",
  runs: ".metator/runs",
};
