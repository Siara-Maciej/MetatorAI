import type { HostTarget } from "./config.ts";
import type { ContainerFix } from "./devcontainer.ts";

/**
 * `metator inspect <path>` (ADR-0105): what a folder is to MetatorAI before anything is written
 * there, as the desktop app's "Add repository" needs it. The decisions are here, pure; what the
 * machine says (git, files, the hosts' programs) is gathered by `InspectFolder`.
 */

/** A host as the person sets it up: where to get it and how to log in (`HostDescriptor.setup`). */
export interface HostSetupHelp {
  readonly install: { readonly url: string; readonly command: string };
  /** How to log in, as a person does it. */
  readonly login: string;
  /**
   * The signs of a login: a variable that holds a key or token, or a file in the home folder
   * (`path` relative to it) that is there, and when `key` is named, holds that key with a value.
   */
  readonly credentials: {
    readonly env: readonly string[];
    readonly files: readonly { readonly path: string; readonly key?: string }[];
  };
  /** How to add it to a dev container (ADR-0106): a feature for `devcontainer.json`, a command for its terminal. */
  readonly container?: ContainerFix;
}

export interface InspectedHost {
  readonly id: HostTarget;
  readonly program: string;
  readonly installed: boolean;
  /** true: a login was found; false: installed, no sign of one; null: not installed. */
  readonly loggedIn: boolean | null;
  readonly install: { readonly url: string; readonly command: string };
  readonly login: string;
  /** In a dev container (ADR-0106): how to add it there. */
  readonly fix?: ContainerFix;
}

/** yes: config and install lock; no: setup has not run (or did not finish); newer: a newer MetatorAI wrote its config. */
export type SetUpState = "yes" | "no" | "newer";

export interface InspectedRepository {
  /** The repository's main checkout, absolute: what is added and opened. */
  readonly root: string;
  readonly name: string;
  /** The path inspected was a linked worktree of `root`. */
  readonly worktree: boolean;
  readonly setUp: SetUpState;
  /** The config file, relative to `root`. */
  readonly config: string | null;
  /** Files with uncommitted changes, tracked and untracked (ignored ones and `.metator/` aside), sorted. */
  readonly uncommitted: readonly string[];
}

export type InspectionKind = "missing" | "not-git" | "repo" | "folder";
export type InspectionNext =
  | "choose-another"
  | "install-git"
  | "git-init"
  | "setup"
  | "add"
  | "setup-repos"
  | "update-app";

export interface Inspection {
  readonly path: string;
  readonly kind: InspectionKind;
  readonly next: InspectionNext;
  readonly git: {
    readonly installed: boolean;
    readonly version: string | null;
    readonly install: { readonly url: string };
    /** In a dev container (ADR-0106): how to add it there. */
    readonly fix?: ContainerFix;
  };
  readonly repository: InspectedRepository | null;
  readonly folder: { readonly file: string | null; readonly repos: readonly InspectedRepository[] } | null;
  readonly hosts: readonly InspectedHost[];
  readonly defaultHost: HostTarget | null;
  /** What `setup --host <h>` writes in a repository not set up yet, per host; empty when none needs it. */
  readonly writes: Partial<Record<HostTarget, readonly string[]>>;
  readonly version: string;
}

/** Where git comes from: the app cannot install it. */
export const GIT_INSTALL = { url: "https://git-scm.com/downloads" } as const;

/**
 * Whether a repository is set up, from its config's `schemaVersion` (undefined: no config) and
 * whether the install lock is there. A config newer than this MetatorAI reads is never touched.
 */
export function setUpState(configVersion: number | undefined, supported: number, lock: boolean): SetUpState {
  if (configVersion === undefined) return "no";
  if (configVersion > supported) return "newer";
  return lock ? "yes" : "no";
}

/** What the app offers next, from what the folder is and the state of its repositories. */
export function nextStep(
  kind: InspectionKind,
  repos: readonly Pick<InspectedRepository, "setUp">[],
): InspectionNext {
  if (kind === "missing") return "choose-another";
  if (kind === "not-git") return "git-init";
  if (repos.some((r) => r.setUp === "newer")) return "update-app";
  if (repos.every((r) => r.setUp === "yes")) return "add";
  return kind === "folder" ? "setup-repos" : "setup";
}

/** The host a setup takes when the person chooses none: the first installed in the team's order. */
export function defaultHost(
  order: readonly string[],
  hosts: readonly Pick<InspectedHost, "id" | "installed">[],
): HostTarget | null {
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  const installed = hosts.filter((h) => h.installed).sort((a, b) => rank(a.id) - rank(b.id));
  return installed[0]?.id ?? null;
}

/**
 * A host's own file in the home folder as the adapter read it: there, with its JSON (undefined when
 * it is not JSON). It is the host's file, not a document of ours, so it is only looked into.
 */
export interface HomeFile {
  readonly json: unknown;
}

/**
 * Whether a host's login is found: a credential variable with a value, or a credential file (with
 * its key holding a value, when one is named). `read` gives a home-relative file, or undefined when
 * it is not there.
 */
export function loginFound(
  credentials: HostSetupHelp["credentials"],
  env: Readonly<Record<string, string | undefined>>,
  read: (path: string) => HomeFile | undefined,
): boolean {
  if (credentials.env.some((name) => (env[name] ?? "").trim() !== "")) return true;
  return credentials.files.some(({ path, key }) => {
    const file = read(path);
    if (file === undefined) return false;
    if (key === undefined) return true;
    if (file.json === null || typeof file.json !== "object") return false;
    const value = (file.json as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.length > 0;
    if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
    return Boolean(value);
  });
}

/** The `schemaVersion` of a parsed document's header, or undefined when it has none. */
export function schemaVersionOf(raw: unknown): number | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const v = (raw as Record<string, unknown>).schemaVersion;
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}
