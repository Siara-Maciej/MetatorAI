/**
 * The files of a run a person reads in the app (`GET /runs/:run/artifacts`): what each is, and
 * which names may be read at all. Only text a stage or the run writes: no path out of the run
 * directory, no file of another kind, nothing larger than a person reads on a screen.
 */

export type RunArtifactKind = "json" | "markdown" | "yaml" | "text";

export interface RunArtifact {
  /** The path relative to the run directory (`plan.md`, `results/mt-planner-1.json`). */
  readonly name: string;
  readonly kind: RunArtifactKind;
  /** Bytes; 0 for an expected artifact not written yet. */
  readonly size: number;
  /** When it was last written; null when it is not written yet. */
  readonly updatedAt: string | null;
  /** True for an artifact the workflow's stages produce that is not written yet. */
  readonly expected: boolean;
  /** The stage that declares it in `produces`, when one does. */
  readonly stage?: string;
  /** The run's own bookkeeping (its record, log, questions), not a stage's artifact. */
  readonly bookkeeping: boolean;
}

export interface RunArtifactText {
  readonly name: string;
  readonly kind: RunArtifactKind;
  readonly text: string;
  /** True when the file was longer than `RUN_ARTIFACT_MAX_BYTES`: `text` is its beginning. */
  readonly truncated: boolean;
}

/** `POST /runs/:run/drive`: a background drive of the run, as `metator run drive --detach` starts it. */
export interface RunDriveStarted {
  readonly started: boolean;
  readonly pid?: number;
  readonly host: string;
}

/** The largest text the app is given of one artifact. */
export const RUN_ARTIFACT_MAX_BYTES = 512 * 1024;

const KINDS: readonly (readonly [RegExp, RunArtifactKind])[] = [
  [/\.json$/i, "json"],
  [/\.md$/i, "markdown"],
  [/\.ya?ml$/i, "yaml"],
  [/\.(txt|log)$/i, "text"],
];

/** The kind of an artifact by its extension; undefined for a file the app does not show. */
export function artifactKind(name: string): RunArtifactKind | undefined {
  return KINDS.find(([pattern]) => pattern.test(name))?.[1];
}

/**
 * Why a name is not one the app may read, or undefined when it may: inside the run directory
 * (relative, no `..`, no backslash or NUL), of a kind it shows.
 */
export function artifactNameProblem(name: string): string | undefined {
  if (name === "" || name.includes("\u0000") || name.includes("\\")) return "not a file name";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "an absolute path";
  if (name.split("/").some((part) => part === ".." || part === "." || part === ""))
    return "a path out of the run directory";
  if (!artifactKind(name)) return "not a kind of file the app shows (.md .json .yml .yaml .txt .log)";
  return undefined;
}

/** The first `max` bytes of a text, cut at a character boundary. */
export function capText(
  text: string,
  max: number = RUN_ARTIFACT_MAX_BYTES,
): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return { text, truncated: false };
  // A cut inside a multi-byte character leaves a replacement character; drop it.
  const cut = new TextDecoder().decode(bytes.slice(0, max)).replace(/�$/, "");
  return { text: cut, truncated: true };
}
