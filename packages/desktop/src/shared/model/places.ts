/**
 * The places a daemon serves (repositories, worktrees) and the state flattened into runs with their repository.
 */
import type { RepoState, StateData, UnreadableRun } from "../api/api.ts";
import { plural } from "./format.ts";
import type { Run } from "./runs.ts";

/** The repository the list screens show in a folder (D10): the remembered one while it is served, else the first. */
export const repoChoice = (
  repos: readonly { readonly name: string }[],
  saved: string | null | undefined,
): string | undefined => (repos.some((r) => r.name === saved) ? (saved as string) : repos[0]?.name);
/**
 * The folder itself where a request names a repository (ADR-0113): the place of the folder's own
 * chats. No repository has this name.
 */
export const FOLDER_PLACE = ".";
/**
 * Where "+ New chat" opens (ADR-0113): in a folder of more than one repository the folder itself,
 * so no repository is picked for the person; else the repository the lists show.
 */
export const chatPlace = (repos: readonly Place[], repo: string | undefined): string | undefined =>
  new Set(repos.map((p) => p.worktreeOf ?? p.name)).size > 1 ? FOLDER_PLACE : repo;
/** The places a chat can open in, the default first: the folder (when it has its own chat), then each checkout. */
export function chatPlaces(repos: readonly Place[]): { readonly name: string; readonly label: string }[] {
  if (chatPlace(repos, undefined) !== FOLDER_PLACE) return [];
  return [
    { name: FOLDER_PLACE, label: "the folder" },
    ...repos.map((p) => ({ name: p.name, label: placeLabel(p) })),
  ];
}
/** Whose a chat is, as its row says it in a folder: `folder`, or its repository; nothing outside a folder. */
export const chatPlaceLabel = (repos: readonly Place[], repo: string | undefined): string | undefined => {
  if (repos.length === 0 || repo === undefined) return undefined;
  if (repo === FOLDER_PLACE) return "folder";
  const place = repos.find((p) => p.name === repo);
  return place ? placeLabel(place) : repo;
};
/* ---------- counts, repositories, routes: what several screens must agree on ---------- */

/** A run the daemon could not read, with the repository it is in when the daemon serves a folder. */
export type Unreadable = UnreadableRun & { readonly repo?: string | undefined };
/**
 * A `/state` answer flattened across a folder's repositories: every run with its repository, the
 * repositories, and the runs the daemon could not read (they are in no list, so the panel names
 * them with the file to restore).
 */
export function flattenState(data: StateData | undefined): {
  runs: Run[];
  repos: Place[];
  unreadable: Unreadable[];
} {
  if (!data) return { runs: [], repos: [], unreadable: [] };
  if ("repos" in data) {
    const all = data.repos as readonly RepoState[];
    return {
      runs: all.flatMap((r) => (r.runs ?? []).map((run) => ({ ...run, repo: r.name }))),
      repos: all.map((r) => ({
        name: r.name,
        path: r.path,
        ...(r.worktreeOf ? { worktreeOf: r.worktreeOf } : {}),
        ...(r.branch ? { branch: r.branch } : {}),
      })),
      unreadable: all.flatMap((r) => (r.unreadable ?? []).map((u) => ({ ...u, repo: r.name }))),
    };
  }
  return { runs: [...data.runs], repos: [], unreadable: [...(data.unreadable ?? [])] };
}
/**
 * A place the daemon serves in a folder: a repository's checkout, by the name requests use. A
 * worktree (`git worktree add ../shop-fix`) is a place of its own, of the repository it names.
 */
export interface Place {
  readonly name: string;
  readonly path: string;
  readonly worktreeOf?: string | undefined;
  readonly branch?: string | undefined;
}
/** How a picker names a place: a worktree by its repository and branch (`shop (fix-tax)`), else its directory. */
export const placeLabel = (p: Place): string =>
  p.worktreeOf ? `${p.worktreeOf} (${p.branch ?? p.path.split("/").pop() ?? p.name})` : p.name;
/** The repository a place is a checkout of. */
const repoOfPlace = (p: Place): string => p.worktreeOf ?? p.name;
/**
 * What the folder holds, counted as repositories (a worktree is not one more): the top bar's
 * words, and each repository with its worktrees as a count (`shop · 2 worktrees`).
 */
export function folderLabel(places: readonly Place[]): { text: string; repos: string[] } {
  if (places.length === 0) return { text: "this repository", repos: [] };
  const names = [...new Set(places.map(repoOfPlace))];
  return {
    text: plural(names.length, "repository", "repositories"),
    repos: names.map((n) => {
      const worktrees = places.filter((p) => p.worktreeOf === n).length;
      return worktrees > 0 ? `${n} · ${plural(worktrees, "worktree")}` : n;
    }),
  };
}
/** How many worktrees the repository of the named place has (the place may be one of them). */
export function worktreeCount(places: readonly Place[], name: string | undefined): number {
  const place = places.find((p) => p.name === name);
  if (!place) return 0;
  const repo = repoOfPlace(place);
  return places.filter((p) => p.worktreeOf === repo).length;
}
/** Two things belong to the same repository; "no repository" (the daemon serves one) is one too. */
export const sameRepo = (a: string | undefined, b: string | undefined): boolean => (a ?? "") === (b ?? "");
