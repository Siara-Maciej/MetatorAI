import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * The installed canon (`metator setup`, `agents install|update`, ADR-0049): which MetatorAI
 * version wrote which file with which content, so an update replaces only what nobody edited.
 */
export const InstallLockSchema = z.strictObject({
  /** The MetatorAI version that last installed or updated the canon. */
  version: z.string().min(1),
  /** The workflows chosen at install (ids); the agents and skills always come in full. */
  workflows: z.array(z.string().min(1)),
  /** Repo-relative path → SHA-256 (hex) of the content MetatorAI wrote there. */
  files: z.record(z.string().min(1), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type InstallLock = z.output<typeof InstallLockSchema>;

export const InstallLockDocument = defineDocument("InstallLock", {
  latest: InstallLockSchema,
  hint: "Written by `metator agents install|update`; do not edit it by hand.",
});

/** SHA-256 (hex) of a file's text, through Web Crypto: no I/O, the same on every runtime. */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What to do with one file of the canon. */
export type InstallAction =
  /** Missing in the repository: written. */
  | "create"
  /** Same content already: nothing to do. */
  | "unchanged"
  /** Nobody changed what MetatorAI wrote last time, and the canon changed: replaced. */
  | "update"
  /** Changed in the repository, the canon unchanged since the last install: left as it is. */
  | "kept"
  /** Changed in the repository and in the canon (or never installed): left as it is. */
  | "conflict"
  /** A conflict the caller chose to resolve with the canon's version (`--theirs`). */
  | "overwrite";

export interface InstallStep {
  readonly path: string;
  readonly action: InstallAction;
}

export interface InstallPlanInput {
  /** Target path → hash of the canon's content. */
  readonly canon: ReadonlyMap<string, string>;
  /** Target path → hash of the file in the repository (absent when the file is missing). */
  readonly current: ReadonlyMap<string, string>;
  /** The lock of the previous install, if any. */
  readonly lock: InstallLock | undefined;
  readonly theirs: boolean;
}

export interface InstallPlan {
  readonly steps: readonly InstallStep[];
  /** Files the previous install wrote that the canon no longer has; reported, never deleted. */
  readonly removedUpstream: readonly string[];
}

/** Decide per file; the only writes are create, update and overwrite. */
export function planInstall(input: InstallPlanInput): InstallPlan {
  const steps: InstallStep[] = [];
  for (const [path, wanted] of [...input.canon].sort(([a], [b]) => a.localeCompare(b))) {
    const have = input.current.get(path);
    const wrote = input.lock?.files[path];
    let action: InstallAction;
    if (have === undefined) action = "create";
    else if (have === wanted) action = "unchanged";
    else if (wrote !== undefined && have === wrote) action = "update";
    else if (wrote !== undefined && wanted === wrote) action = "kept";
    else action = input.theirs ? "overwrite" : "conflict";
    steps.push({ path, action });
  }
  const removedUpstream = Object.keys(input.lock?.files ?? {})
    .filter((p) => !input.canon.has(p))
    .sort();
  return { steps, removedUpstream };
}

/** Whether the file holds the canon's content after the step (what the new lock records). */
export function holdsCanon(action: InstallAction): boolean {
  return action !== "conflict" && action !== "kept";
}

/** Whether the step writes the file. */
export function writesFile(action: InstallAction): boolean {
  return action === "create" || action === "update" || action === "overwrite";
}
