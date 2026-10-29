import semver from "semver";
import type { Contract, SystemMap } from "./system-map.ts";

/** One difference between two versions of a specification (F7.4). */
export interface ContractChange {
  /** The differ's own code, e.g. `path.remove` or `response.body.scope.add`. */
  readonly code: string;
  readonly severity: "breaking" | "non-breaking" | "unclassified";
  /** Where in the specification, e.g. `paths./invoices.get`. */
  readonly location: string;
  readonly message: string;
}

export interface ContractComparison {
  readonly changes: readonly ContractChange[];
  /** The specification's own version (`info.version` for OpenAPI), before and after. */
  readonly versions: { readonly before?: string; readonly after?: string };
}

/**
 * `contract diff` (F7.4, ADR-0069): what a change does to a contract, judged against the map.
 * A breaking change to a contract whose compatibility is not `none` passes only under the
 * `versioned` policy with a new major version; consumers whose range excludes the new version
 * are named, so a plan migrates them.
 */
export type ContractStatus = "unchanged" | "compatible" | "unclassified" | "breaking" | "added" | "removed";

export interface ConsumerRange {
  readonly app: string;
  readonly range?: string;
  /** Whether the new version is inside the consumer's range (unknown without both). */
  readonly satisfied?: boolean;
}

export interface ContractVerdict {
  readonly status: ContractStatus;
  readonly allowed: boolean;
  /** Why it is not allowed, or what to watch for. */
  readonly reason?: string;
  readonly consumers: readonly ConsumerRange[];
}

/** The status the changes add up to: one breaking change makes the contract breaking. */
export function statusOf(
  changes: readonly ContractChange[],
  presence: { readonly before: boolean; readonly after: boolean },
): ContractStatus {
  if (!presence.before) return presence.after ? "added" : "unchanged";
  if (!presence.after) return "removed";
  if (changes.some((c) => c.severity === "breaking")) return "breaking";
  if (changes.some((c) => c.severity === "unclassified")) return "unclassified";
  return changes.length > 0 ? "compatible" : "unchanged";
}

const major = (version: string | undefined): number | undefined => {
  const v = version ? semver.coerce(version) : null;
  return v ? v.major : undefined;
};

/** Whether `version` is inside `range`; undefined when either is not semver. */
export function inRange(version: string | undefined, range: string | undefined): boolean | undefined {
  const v = version ? semver.coerce(version) : null;
  if (!v || !range || semver.validRange(range) === null) return undefined;
  return semver.satisfies(v, range);
}

/** The verdict on one contract's change under the map's compatibility and breaking policy. */
export function judgeContract(input: {
  readonly contract: Contract;
  readonly policies: SystemMap["policies"];
  readonly status: ContractStatus;
  readonly versions: { readonly before?: string; readonly after?: string };
  readonly consumers: readonly { readonly app: string; readonly range?: string }[];
}): ContractVerdict {
  const { contract, policies, status, versions } = input;
  const consumers = input.consumers.map((c) => {
    const satisfied = inRange(versions.after, c.range);
    return {
      app: c.app,
      ...(c.range ? { range: c.range } : {}),
      ...(satisfied === undefined ? {} : { satisfied }),
    };
  });
  const outside = consumers.filter((c) => c.satisfied === false).map((c) => c.app);
  const migrate =
    outside.length > 0 ? ` Consumers outside the new version's range: ${outside.join(", ")}.` : "";
  if (status === "unclassified")
    return {
      status,
      allowed: true,
      reason: "some changes could not be classified: review them by hand",
      consumers,
    };
  if (status !== "breaking" && status !== "removed")
    return { status, allowed: true, ...(migrate ? { reason: migrate.trim() } : {}), consumers };
  const users = consumers.length > 0 ? ` (consumed by ${consumers.map((c) => c.app).join(", ")})` : "";
  if (contract.compatibility === "none")
    return { status, allowed: true, reason: `compatibility is none${users}.${migrate}`, consumers };
  if (policies.breaking === "versioned") {
    const before = major(versions.before);
    const after = major(versions.after);
    if (status === "breaking" && before !== undefined && after !== undefined && after > before)
      return { status, allowed: true, reason: `a new major version ${versions.after}.${migrate}`, consumers };
    return {
      status,
      allowed: false,
      reason: `a breaking change${users} needs a new major version (policy: versioned).${migrate}`,
      consumers,
    };
  }
  if (policies.breaking === "forbidden")
    return { status, allowed: false, reason: `breaking changes are forbidden${users}.${migrate}`, consumers };
  return {
    status,
    allowed: false,
    reason: `a breaking change${users}: expand first (the new shape beside the old), migrate the consumers, then remove the old (policy: expand-contract).${migrate}`,
    consumers,
  };
}
