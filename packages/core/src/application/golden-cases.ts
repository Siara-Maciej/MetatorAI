import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { VersionedDocument } from "../domain/versioned.ts";
import type { ReadonlyFileSystem, Sandbox } from "../ports/index.ts";
import { scanDocuments } from "./document-io.ts";

/** A golden case: its id and the files of the repository it is tried in. */
export interface GoldenCase {
  readonly id: string;
  readonly files: Readonly<Record<string, string>>;
}

/** Every golden case of a directory (`<dir>/*.yml`), in id order; one invalid case fails them all. */
export async function loadGoldenCases<C extends { readonly id: string }>(
  fs: ReadonlyFileSystem,
  dir: string,
  doc: VersionedDocument<C>,
): Promise<Result<readonly C[], MetatorError>> {
  const scan = await scanDocuments(fs, [`${dir}/*.yml`], doc, { format: "yaml" });
  const problem = scan.problems[0];
  if (problem) return err(problem.error);
  return ok(scan.entries.map((e) => e.value).sort((a, b) => a.id.localeCompare(b.id)));
}

/**
 * Scores the golden cases (one, with `only`), each in a fresh sandbox repository holding the
 * case's files over `extra`'s; the sandbox is disposed whatever the scoring did. No case to run
 * is NOT_FOUND, named with `noun` ("arch eval").
 */
export async function runGoldenCases<C extends GoldenCase, S>(input: {
  readonly cases: readonly C[];
  readonly only?: string;
  readonly noun: string;
  readonly dir: string;
  readonly sandbox: Sandbox;
  /** Files every sandbox gets besides the case's; asked for only when there is a case to run. */
  readonly extra: () => Promise<Readonly<Record<string, string>>>;
  readonly score: (c: C, root: string) => Promise<S>;
}): Promise<Result<S[], MetatorError>> {
  const selected = input.cases.filter((c) => !input.only || c.id === input.only);
  if (selected.length === 0)
    return err(
      MetatorError.notFound(
        input.only ? `${input.noun} case ${input.only}` : `${input.noun} cases in ${input.dir}`,
      ),
    );
  const extra = await input.extra();
  const scores: S[] = [];
  for (const c of selected) {
    const box = await input.sandbox.create({ ...extra, ...c.files });
    if (box.isErr()) return err(box.error);
    try {
      scores.push(await input.score(c, box.value.root));
    } finally {
      await box.value.dispose();
    }
  }
  return ok(scores);
}
