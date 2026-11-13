import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  type DocumentHeader,
  parseJsonDocument,
  parseYamlDocument,
  readFrontMatter,
  renderYamlDocument,
  serializeJsonDocument,
  type VersionedDocument,
} from "../domain/versioned.ts";
import type { FileSystem, ReadonlyFileSystem } from "../ports/index.ts";

/** How a document is written in its file: JSON, YAML, or YAML front matter of a Markdown file. */
export type DocumentFormat = "json" | "yaml" | "front-matter";

/** The format a file's name says: `.json` and `.jsonl` are JSON, `.md` front matter, the rest YAML. */
export function documentFormat(file: string): DocumentFormat {
  if (file.endsWith(".json") || file.endsWith(".jsonl")) return "json";
  return file.endsWith(".md") ? "front-matter" : "yaml";
}

/** A document's text parsed and validated (migrated when older); `source` names it in errors. */
export function parseDocumentText<T>(
  text: string,
  source: string,
  doc: VersionedDocument<T>,
  format: DocumentFormat = documentFormat(source),
): Result<T, MetatorError> {
  const raw =
    format === "json"
      ? parseJsonDocument(text, source)
      : format === "yaml"
        ? parseYamlDocument(text, source)
        : readFrontMatter(text, source);
  return raw.andThen((value) => doc.parse(value, source));
}

/** Reads a document that must be there: a file that cannot be read is the file system's error. */
export async function loadDocument<T>(
  fs: Pick<ReadonlyFileSystem, "read">,
  file: string,
  doc: VersionedDocument<T>,
  format?: DocumentFormat,
): Promise<Result<T, MetatorError>> {
  const text = await fs.read(file);
  if (text.isErr()) return err(text.error);
  return parseDocumentText(text.value, file, doc, format);
}

/** Reads a document that may be absent: undefined when there is no such file. */
export async function readDocument<T>(
  fs: Pick<ReadonlyFileSystem, "read" | "exists">,
  file: string,
  doc: VersionedDocument<T>,
  format?: DocumentFormat,
): Promise<Result<T | undefined, MetatorError>> {
  if (!(await fs.exists(file))) return ok(undefined);
  return loadDocument(fs, file, doc, format);
}

/**
 * Writes a document with the current header (`kind`, `schemaVersion`): JSON, or YAML under an
 * optional leading comment. The format is the file name's unless given.
 */
export function writeDocument<T>(
  fs: Pick<FileSystem, "write">,
  file: string,
  doc: VersionedDocument<T>,
  body: T,
  format: "json" | "yaml" = documentFormat(file) === "json" ? "json" : "yaml",
  comment?: string,
): Promise<Result<void, MetatorError>> {
  const stamped = doc.stamp(body);
  return fs.write(
    file,
    format === "json"
      ? serializeJsonDocument(stamped)
      : renderYamlDocument({ ...stamped } as DocumentHeader & Record<string, unknown>, comment),
  );
}

/**
 * Every line of a JSON Lines file as a document (empty when there is no file). A line that cannot
 * be read fails the whole read (`fail`) or is left out (`skip`: a writer killed mid-append leaves
 * a torn line, and the rest still reads). With `numbered`, errors name the line (`file:3`).
 */
export async function readJsonLines<T>(
  fs: Pick<ReadonlyFileSystem, "read" | "exists">,
  file: string,
  doc: VersionedDocument<T>,
  onBadLine: "fail" | "skip",
  numbered = true,
): Promise<Result<T[], MetatorError>> {
  if (!(await fs.exists(file))) return ok([]);
  const text = await fs.read(file);
  if (text.isErr()) return err(text.error);
  const out: T[] = [];
  for (const [i, line] of text.value.split("\n").entries()) {
    if (line.trim() === "") continue;
    const parsed = parseDocumentText(line, numbered ? `${file}:${i + 1}` : file, doc, "json");
    if (parsed.isOk()) out.push(parsed.value);
    else if (onBadLine === "fail") return err(parsed.error);
  }
  return ok(out);
}

/** One file a scan could read, with its text (a Markdown document's body follows its header). */
export interface ScannedDocument<T> {
  readonly value: T;
  readonly source: string;
  readonly text: string;
}

export interface DocumentProblem {
  readonly source: string;
  readonly error: MetatorError;
}

export interface DocumentScan<T> {
  readonly entries: readonly ScannedDocument<T>[];
  /** Files that are not valid documents; with `unreadable: "skip"` a file that cannot be read is not one. */
  readonly problems: readonly DocumentProblem[];
}

/**
 * Every document the globs match, in path order: the valid ones, and why the others are not. A
 * file the file system cannot read is a problem too, or left out with `unreadable: "skip"`.
 */
export async function scanDocuments<T>(
  fs: ReadonlyFileSystem,
  globs: readonly string[],
  doc: VersionedDocument<T>,
  options: { readonly format?: DocumentFormat; readonly unreadable?: "problem" | "skip" } = {},
): Promise<DocumentScan<T>> {
  const entries: ScannedDocument<T>[] = [];
  const problems: DocumentProblem[] = [];
  for (const source of [...(await fs.glob(globs))].sort()) {
    const text = await fs.read(source);
    if (text.isErr()) {
      if (options.unreadable !== "skip") problems.push({ source, error: text.error });
      continue;
    }
    const parsed = parseDocumentText(text.value, source, doc, options.format);
    if (parsed.isOk()) entries.push({ value: parsed.value, source, text: text.value });
    else problems.push({ source, error: parsed.error });
  }
  return { entries, problems };
}
