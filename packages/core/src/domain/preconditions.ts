/**
 * What a workflow may require before a run starts (`preconditions`, 02-workflows §1.3). The list
 * is closed: each kind is decided by a tool when the run starts. A kind that is not here cannot be
 * checked, so `workflow lint` rejects it and a run refuses to start on it rather than assume it holds.
 */
export const PRECONDITIONS = {
  "clean-tree": "no tracked file has uncommitted changes",
  "branch-ok": "the checkout is on a branch, not on a detached HEAD",
  "tests-green": "the quick gate passes",
} as const;

export type PreconditionKind = keyof typeof PRECONDITIONS;

export const isPrecondition = (kind: string): kind is PreconditionKind => Object.hasOwn(PRECONDITIONS, kind);

/** The declared preconditions the engine has no check for. */
export const uncheckablePreconditions = (declared: readonly string[]): string[] =>
  declared.filter((p) => !isPrecondition(p));

export const preconditionKinds = (): string => Object.keys(PRECONDITIONS).join(", ");
