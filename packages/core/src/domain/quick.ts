/**
 * Is a change small enough for the quick way (ADR-0093)? Decided without a model, from facts the
 * existing tools give (the import graph, the workspace's packages, the API snapshots, the system
 * map) and from the files themselves. Any one escalator makes the change not quick; each says why
 * and which tool saw it. Computed before the start (from the files the change is expected to
 * touch) and again after the build (from the real diff).
 */
export interface QuickLimitsOf {
  readonly maxFiles: number;
  readonly maxLines: number;
  readonly maxDependents: number;
}

export interface QuickFacts {
  /** The files the change touches (predicted, or the diff's). */
  readonly files: readonly string[];
  /** The diff itself, when there is one: its size and what it adds are read from it. */
  readonly patch?: string;
  /** Changed lines, when known without a patch. */
  readonly lines?: number;
  /** The workspace packages the files are in. */
  readonly packages: readonly string[];
  /** Files outside the change that depend on it, transitively. */
  readonly dependents: number;
  /** Packages whose public API changes. */
  readonly publicApi: readonly string[];
  /** Changed source files that no test reaches. */
  readonly untested: readonly string[];
  /** Contracts of the system map the change touches. */
  readonly contracts: readonly string[];
  /** Other applications (repositories) the change reaches. */
  readonly repositories: readonly string[];
  /** The task as the person gave it: its words name what no file shows yet. */
  readonly task?: string;
}

export interface Escalator {
  readonly id:
    | "cross-repository"
    | "contract"
    | "public-api"
    | "package-boundary"
    | "dependents"
    | "migration"
    | "schema-version"
    | "dependency"
    | "ci-config"
    | "untested"
    | "size";
  readonly why: string;
  /** The tool that saw it, as a command a person can run. */
  readonly source: string;
}

export interface QuickVerdict {
  readonly quick: boolean;
  readonly escalators: readonly Escalator[];
  readonly thresholds: QuickLimitsOf;
}

/** Added plus removed lines of a unified diff (headers are not changes). */
export function changedLines(patch: string): number {
  return patch.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
}

/** The lines a diff adds to the files that match, without the `+`. */
function addedIn(patch: string, file: RegExp): string[] {
  const out: string[] = [];
  let inFile = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) inFile = file.test(line.slice(4).replace(/^b\//, ""));
    else if (inFile && line.startsWith("+") && !line.startsWith("+++")) out.push(line.slice(1));
  }
  return out;
}

const MIGRATION = /(^|\/)migrations?\/|\.sql$|(^|\/)migrate[^/]*$/i;
const SCHEMA = /(^|\/)schemas?\/[^/]+\.json$|\.schema\.json$|(^|\/)schema\.(prisma|graphql|sql)$/i;
const CI =
  /^\.github\/workflows\/|(^|\/)\.gitlab-ci\.yml$|^\.circleci\/|(^|\/)azure-pipelines\.yml$|(^|\/)Jenkinsfile$|^\.buildkite\//;
const LOCKFILE =
  /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock)$/;
const MANIFEST = /(^|\/)(package\.json|go\.mod|Cargo\.toml|requirements[^/]*\.txt|pyproject\.toml)$/;
/** A line that adds a dependency to a manifest: `"name": "^1.2.3"`, `name==1.0`, `name = "1"`. */
const DEPENDENCY_LINE =
  /^\s*"[^"]+":\s*"(?:[\^~<>=]*\d|workspace:|npm:|github:|file:|link:|\*|latest)|^\s*[A-Za-z0-9_.-]+\s*(==|>=|~=)\s*\d|^\s*[A-Za-z0-9_-]+\s*=\s*(\{|"[\^~]?\d)|^\s*require\s|^\s+[\w./-]+\s+v\d/;

/** What a task's words name (English and Polish): each is an escalator no file needs to show. */
const TASK_WORDS: readonly (readonly [Escalator["id"], RegExp, string])[] = [
  [
    "cross-repository",
    /\b(both|other|another|all|across)\s+(the\s+)?(repositor(y|ies)|repos?)\b|\b(obu|innym|wszystkich)\s+repozytori/i,
    "the task speaks of more than one repository",
  ],
  ["migration", /\bmigrat(e|es|ion|ions|ing)\b|(^|[^\p{L}])migracj/iu, "the task speaks of a migration"],
  [
    "schema-version",
    /\bschema\s?versions?\b|(^|[^\p{L}])wersj\p{L}*\s+schemat/iu,
    "the task speaks of a schema version",
  ],
  [
    "dependency",
    /\b(add|install|upgrade|bump|update|remove)\b.{0,40}?\b(dependenc(y|ies)|package|library)\b|(^|[^\p{L}])zależnoś/iu,
    "the task adds or changes a dependency",
  ],
  [
    "ci-config",
    /\bCI\b|\b(ci|build|deploy)\s+pipeline\b|\bgithub\s+actions?\b/,
    "the task speaks of CI configuration",
  ],
];

/** The escalators a task's own words name, before any file is known (`quick check --task`). */
export function taskEscalators(task: string): Escalator[] {
  return TASK_WORDS.filter(([, words]) => words.test(task)).map(([id, , why]) => ({
    id,
    why,
    source: "the task's words",
  }));
}

/** The files a task names: words that read as paths (a directory, or a name with an extension). */
export function taskFiles(task: string): string[] {
  const out: string[] = [];
  for (const raw of task.split(/[\s,;()"'`]+/)) {
    const word = raw.replace(/[.:!?]+$/, "");
    const path = /^[\w@.-]+(\/[\w@.-]+)+$/.test(word) && /[A-Za-z]/.test(word);
    const named = /^[\w-]{2,}(\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(word) && !/^\d/.test(word);
    if ((path || named) && !out.includes(word)) out.push(word);
  }
  return out;
}

export function quickCheck(facts: QuickFacts, limits: QuickLimitsOf): QuickVerdict {
  const escalators: Escalator[] = [];
  const add = (id: Escalator["id"], why: string, source: string) => escalators.push({ id, why, source });
  const patch = facts.patch;
  if (facts.repositories.length > 0)
    add(
      "cross-repository",
      `it reaches another repository: ${facts.repositories.join(", ")}`,
      "metator system impact",
    );
  if (facts.contracts.length > 0)
    add("contract", `it touches a contract: ${facts.contracts.join(", ")}`, "metator system impact");
  if (facts.publicApi.length > 0)
    add("public-api", `the public API of ${facts.publicApi.join(", ")} changes`, "metator api diff");
  if (facts.packages.length > 1)
    add(
      "package-boundary",
      `it crosses a package boundary: ${facts.packages.join(", ")}`,
      "metator graph dependents --transitive",
    );
  if (facts.dependents > limits.maxDependents)
    add(
      "dependents",
      `${facts.dependents} files depend on what it changes (limit ${limits.maxDependents})`,
      "metator graph dependents --transitive",
    );
  const migrations = facts.files.filter((f) => MIGRATION.test(f));
  if (migrations.length > 0) add("migration", `a migration: ${migrations.join(", ")}`, "git diff");
  const schemas = facts.files.filter((f) => SCHEMA.test(f));
  const versions = patch ? addedIn(patch, /./).filter((l) => /\bschemaVersion\b/.test(l)) : [];
  if (schemas.length > 0 || versions.length > 0)
    add(
      "schema-version",
      schemas.length > 0 ? `a schema: ${schemas.join(", ")}` : "a document's schemaVersion changes",
      "git diff",
    );
  const locks = facts.files.filter((f) => LOCKFILE.test(f));
  const manifests = facts.files.filter((f) => MANIFEST.test(f));
  // Before the change a manifest may bring a dependency; with the diff, only a line that adds one does.
  const addsDependency = patch
    ? addedIn(patch, MANIFEST).some((l) => DEPENDENCY_LINE.test(l))
    : manifests.length > 0;
  if (locks.length > 0 || addsDependency)
    add("dependency", `a dependency: ${[...locks, ...manifests].join(", ")}`, "git diff");
  const ci = facts.files.filter((f) => CI.test(f));
  if (ci.length > 0) add("ci-config", `CI configuration: ${ci.join(", ")}`, "git diff");
  if (facts.untested.length > 0)
    add("untested", `no test reaches ${facts.untested.join(", ")}`, "metator graph dependents --transitive");
  const lines = facts.lines ?? (patch !== undefined ? changedLines(patch) : undefined);
  if (facts.files.length > limits.maxFiles)
    add("size", `${facts.files.length} files (limit ${limits.maxFiles})`, "git diff");
  else if (lines !== undefined && lines > limits.maxLines)
    add("size", `${lines} changed lines (limit ${limits.maxLines})`, "git diff");
  for (const hint of facts.task ? taskEscalators(facts.task) : [])
    if (!escalators.some((e) => e.id === hint.id)) escalators.push(hint);
  return { quick: escalators.length === 0, escalators, thresholds: limits };
}

/** The escalators a person's sentence never lifts. */
export const NEVER_OVERRIDDEN: readonly Escalator["id"][] = ["cross-repository"];

/**
 * May the quick way start although escalators tripped? With none, yes. With some, only with the
 * person's own sentence (recorded with the run), and never when the change reaches another
 * repository.
 */
export function quickOverride(
  escalators: readonly { readonly id: string; readonly why: string }[],
  words: string | undefined,
):
  | { readonly allowed: true; readonly overridden?: readonly string[] }
  | { readonly allowed: false; readonly why: string } {
  if (escalators.length === 0) return { allowed: true };
  const hard = escalators.find((e) => (NEVER_OVERRIDDEN as readonly string[]).includes(e.id));
  if (hard)
    return {
      allowed: false,
      why: `not quick, and this cannot be overridden: it reaches another repository (${hard.why}). Use the full workflow (mt-system-change).`,
    };
  if (!words || words.trim() === "")
    return {
      allowed: false,
      why: `not quick: ${escalators.map((e) => `${e.id} (${e.why})`).join("; ")}. The person may keep it quick with one sentence (--override "<their words>").`,
    };
  return { allowed: true, overridden: escalators.map((e) => e.id) };
}

/** The two cards of a quick run, as the apps recognise them: by these exact words. */
export const QUICK_READY_PROMPT = "Quick change ready: look at the diff";
export const QUICK_GREW_PROMPT = "This grew past quick: ";
export const QUICK_OPTIONS = {
  openDiff: "Open diff",
  fine: "Fine",
  full: "Continue as full",
  keep: "Keep as quick",
} as const;
/** Who asks the two cards: MetatorAI itself, not a model. */
export const QUICK_ASKER = "metator";

/** The answer that ends a quick run: `Fine` on its last card (`Open diff` is what an app does, no answer). */
export function endsQuickRun(q: {
  readonly prompt: string;
  readonly answer?: { readonly choices: readonly string[] } | undefined;
}): boolean {
  return q.prompt === QUICK_READY_PROMPT && q.answer?.choices.includes(QUICK_OPTIONS.fine) === true;
}
