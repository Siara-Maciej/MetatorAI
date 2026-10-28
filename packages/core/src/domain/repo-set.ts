import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * A folder of repositories (G2, ADR-0057): `metator.repos.yml` in the folder that holds them. Each
 * repository keeps its own MetatorAI; the folder only gathers them for `metator ui`, `ask`,
 * `status` and `repos`. Nothing is shared.
 */
export const REPO_SET_FILE = "metator.repos.yml";

const RepoSchema = z.strictObject({
  /** Folder-relative directory of the repository, forward slashes, no `..`. */
  path: z
    .string()
    .min(1)
    .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "a path inside the folder"),
  /** How the repository is shown (default: the last part of its path). */
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .optional(),
});

export const RepoSetSchema = z.strictObject({
  repos: z.array(RepoSchema).min(1, "list at least one repository"),
});
export type RepoSet = z.output<typeof RepoSetSchema>;

export const RepoSetDocument = defineDocument("RepoSet", {
  latest: RepoSetSchema,
  errorCode: "INVALID_CONFIG",
  hint: "`metator repos init` proposes one from the repositories in this folder.",
});

export interface FolderRepo {
  readonly name: string;
  /** Folder-relative path. */
  readonly path: string;
}

/** The repositories of a set with their names; duplicate names are a problem. */
export function reposOf(set: RepoSet): { repos: FolderRepo[]; problems: string[] } {
  const repos = set.repos.map((r) => ({
    name: r.name ?? r.path.replace(/\/+$/, "").split("/").pop() ?? r.path,
    path: r.path.replace(/\/+$/, ""),
  }));
  const names = repos.map((r) => r.name);
  const problems = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))].map(
    (n) => `two repositories are named ${n}; give one of them a \`name\``,
  );
  return { repos, problems };
}

/** The set `repos init` proposes: every repository found, by path; names only where two clash. */
export function proposeRepoSet(found: readonly string[]): RepoSet {
  const sorted = [...new Set(found)].sort();
  const last = (p: string) => p.split("/").pop() ?? p;
  return {
    repos: sorted.map((path) => {
      const clash = sorted.filter((p) => last(p) === last(path)).length > 1;
      return clash ? { path, name: path.replaceAll("/", "-") } : { path };
    }),
  };
}
