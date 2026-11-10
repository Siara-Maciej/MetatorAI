import { MetatorError } from "../domain/errors.ts";
import { type EvalCase, EvalCaseDocument } from "../domain/eval.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { firstChangedLine, unifiedDiff } from "../domain/unified-diff.ts";
import { renderYamlDocument } from "../domain/versioned.ts";
import type { FileSystem, ProcessRunner } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";

/** A known bug the unit suite catches (scripts/mutants.ts): planted on the base, it is a seeded case. */
export interface SeedMutant {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly why: string;
}

export interface SeedGoldenInput {
  readonly mutants: readonly SeedMutant[];
  /** How many of each kind to write (as many as the inputs allow). */
  readonly seeded: number;
  readonly bugs: number;
  readonly clean: number;
  /** The ref seeded cases are planted on (default HEAD); pinned to its hash. */
  readonly base?: string;
  /** Commits whose subject matches this are fixes: the bug they fix is a case. */
  readonly fixPattern?: string;
  /** How far back the history is read for fixes and clean changes. */
  readonly history?: number;
}

export interface SeedGoldenReport {
  readonly written: readonly {
    readonly id: string;
    readonly type: EvalCase["type"];
    readonly file: string;
  }[];
  readonly skipped: readonly string[];
  readonly dir: string;
}

const DEFAULT_FIX = "\\b(fix|fixes|fixed|revert|bug|regression|hotfix)\\b";
const NOT_CODE = /\.(md|txt|svg|png|jpg|lock)$/i;

/**
 * `metator eval seed` (F3): a golden set of ≥ 50 cases from what the repository already knows.
 * Seeded cases plant the unit suite's mutants on the base commit as patches (a review must find
 * the planted bug); bug cases are the commits a later fix repaired, found by blaming the lines
 * the fix removed (a review must find them before the fix did); clean cases are ordinary commits
 * (a review must not block them). Every case is an `EvalCase` YAML under `paths.evals`.
 */
export class SeedGoldenSet {
  constructor(
    private readonly d: {
      readonly fs: FileSystem;
      readonly paths: Pick<MetatorPaths, "evals">;
      readonly runner: Pick<ProcessRunner, "run">;
      readonly root: string;
    },
  ) {}

  async execute(input: SeedGoldenInput): Promise<Result<SeedGoldenReport, MetatorError>> {
    const written: { id: string; type: EvalCase["type"]; file: string }[] = [];
    const skipped: string[] = [];
    const base = await this.git(["rev-parse", input.base ?? "HEAD"]);
    if (base.isErr()) return err(base.error);
    const seeded = await this.seeded(input.mutants, input.seeded, base.value, skipped);
    if (seeded.isErr()) return err(seeded.error);
    const bugs = await this.bugs(input.bugs, input.fixPattern ?? DEFAULT_FIX, input.history ?? 500, skipped);
    if (bugs.isErr()) return err(bugs.error);
    // A commit a later fix repaired is a bug case, never a clean one.
    const notClean = new Set(bugs.value.map((b) => b.head));
    const clean = await this.clean(
      input.clean,
      input.fixPattern ?? DEFAULT_FIX,
      input.history ?? 500,
      notClean,
      skipped,
    );
    if (clean.isErr()) return err(clean.error);
    for (const c of [...seeded.value, ...bugs.value, ...clean.value]) {
      const file = `${this.d.paths.evals}/${c.id}.yml`;
      const stamped = EvalCaseDocument.stamp(c);
      const saved = await this.d.fs.write(
        file,
        renderYamlDocument(
          { kind: stamped.kind, schemaVersion: stamped.schemaVersion, ...c },
          `Written by \`metator eval seed\`; edit the expected findings, never the ids.`,
        ),
      );
      if (saved.isErr()) return err(saved.error);
      written.push({ id: c.id, type: c.type, file });
    }
    return ok({ written, skipped, dir: this.d.paths.evals });
  }

  /** Mutants whose `from` occurs exactly once in the file at the base, planted as a patch. */
  private async seeded(
    mutants: readonly SeedMutant[],
    count: number,
    base: string,
    skipped: string[],
  ): Promise<Result<EvalCase[], MetatorError>> {
    const out: EvalCase[] = [];
    const taken = new Map<string, number>();
    for (const m of mutants) {
      if (out.length >= count) break;
      const before = await this.git(["show", `${base}:${m.file}`]);
      if (before.isErr()) {
        skipped.push(`${m.file}: not in ${base.slice(0, 12)}`);
        continue;
      }
      const hits = before.value.split(m.from).length - 1;
      if (hits !== 1) {
        skipped.push(`${m.file}: "${m.from.slice(0, 40)}" found ${hits} times, not once`);
        continue;
      }
      const after = before.value.replace(m.from, m.to);
      const stem = m.file
        .replace(/^packages\//, "")
        .replace(/\.[a-z]+$/, "")
        .replace(/[^a-z0-9]+/gi, "-")
        .toLowerCase();
      const n = (taken.get(stem) ?? 0) + 1;
      taken.set(stem, n);
      const id = `seeded-${stem}-${n}`;
      const patch = `${this.d.paths.evals}/patches/${id}.patch`;
      const saved = await this.d.fs.write(patch, unifiedDiff(m.file, before.value, after));
      if (saved.isErr()) return err(saved.error);
      out.push({
        id,
        type: "seeded",
        base,
        head: `golden/${id}`,
        patch,
        origin: `scripts/mutants.ts: ${m.why}`,
        description: m.why,
        expected: [
          {
            file: m.file,
            line: firstChangedLine(before.value, after),
            tolerance: 3,
            severity: "blocking",
            note: m.why,
          },
        ],
      });
    }
    return ok(out);
  }

  /** The commits a fix repaired: blame the lines the fix removed; one introducing commit makes a case. */
  private async bugs(
    count: number,
    fixPattern: string,
    history: number,
    skipped: string[],
  ): Promise<Result<EvalCase[], MetatorError>> {
    const out: EvalCase[] = [];
    if (count === 0) return ok(out);
    const log = await this.git([
      "log",
      `-n${history}`,
      "--format=%H%x00%s",
      "-i",
      "-E",
      `--grep=${fixPattern}`,
    ]);
    if (log.isErr()) return err(log.error);
    const seen = new Set<string>();
    for (const line of log.value.split("\n").filter((l) => l !== "")) {
      if (out.length >= count) break;
      const [fix, subject = ""] = line.split("\0") as [string, string];
      const show = await this.git(["show", "--format=", "--unified=0", "--no-renames", fix]);
      if (show.isErr()) continue;
      const removed = removedRanges(show.value).filter((r) => !NOT_CODE.test(r.file));
      if (removed.length === 0 || removed.length > 6) {
        skipped.push(
          `${fix.slice(0, 12)} ${subject}: ${removed.length === 0 ? "removes no code line" : "touches too much"}`,
        );
        continue;
      }
      const expected: EvalCase["expected"] = [];
      const culprits = new Set<string>();
      for (const r of removed) {
        const blame = await this.git([
          "blame",
          "--porcelain",
          "-L",
          `${r.start},${r.end}`,
          `${fix}^`,
          "--",
          r.file,
        ]);
        if (blame.isErr()) continue;
        for (const [sha, origLine] of blameLines(blame.value)) {
          culprits.add(sha);
          if (!expected.some((e) => e.file === r.file && e.line === origLine))
            expected.push({
              file: r.file,
              line: origLine,
              tolerance: 3,
              severity: "blocking",
              note: `fixed by ${fix.slice(0, 12)}: ${subject}`,
            });
        }
      }
      const culprit = [...culprits][0];
      if (!culprit || culprits.size !== 1 || culprit === fix || expected.length === 0) {
        skipped.push(`${fix.slice(0, 12)} ${subject}: the removed lines come from ${culprits.size} commits`);
        continue;
      }
      if (seen.has(culprit)) continue;
      const parent = await this.git(["rev-parse", `${culprit}^`]);
      if (parent.isErr()) {
        skipped.push(`${culprit.slice(0, 12)}: no parent`);
        continue;
      }
      const culpritSubject = (await this.git(["log", "-1", "--format=%s", culprit])).unwrapOr("");
      // The same fix cherry-picked onto two branches repairs the same subject: one case is enough.
      if (seen.has(`subject:${culpritSubject}`)) continue;
      seen.add(culprit);
      seen.add(`subject:${culpritSubject}`);
      out.push({
        id: `bug-${culprit.slice(0, 10)}`,
        type: "bug",
        base: parent.value,
        head: culprit,
        origin: `fixed by ${fix}`,
        description: `${culpritSubject} (fixed later by: ${subject})`,
        expected: expected.slice(0, 8),
      });
    }
    return ok(out);
  }

  /** Ordinary commits that touch code and look like no fix: a review must not block them. */
  private async clean(
    count: number,
    fixPattern: string,
    history: number,
    exclude: ReadonlySet<string>,
    skipped: string[],
  ): Promise<Result<EvalCase[], MetatorError>> {
    const out: EvalCase[] = [];
    if (count === 0) return ok(out);
    const log = await this.git(["log", `-n${history}`, "--format=%H%x00%s", "--no-merges"]);
    if (log.isErr()) return err(log.error);
    const fix = new RegExp(fixPattern, "i");
    // The same change cherry-picked onto two branches has one subject: one case is enough.
    const subjects = new Set<string>();
    for (const line of log.value.split("\n").filter((l) => l !== "")) {
      if (out.length >= count) break;
      const [sha, subject = ""] = line.split("\0") as [string, string];
      if (fix.test(subject) || exclude.has(sha)) continue;
      if (subjects.has(subject)) {
        skipped.push(`${sha.slice(0, 12)} ${subject}: the same subject is already a case`);
        continue;
      }
      const files = await this.git(["show", "--format=", "--name-only", sha]);
      if (files.isErr()) continue;
      const code = files.value.split("\n").filter((f) => f !== "" && !NOT_CODE.test(f));
      if (code.length === 0 || code.length > 30) {
        skipped.push(
          `${sha.slice(0, 12)} ${subject}: ${code.length === 0 ? "no code" : "too large"} for a clean case`,
        );
        continue;
      }
      const parent = await this.git(["rev-parse", `${sha}^`]);
      if (parent.isErr()) continue;
      subjects.add(subject);
      out.push({
        id: `clean-${sha.slice(0, 10)}`,
        type: "clean",
        base: parent.value,
        head: sha,
        origin: "history",
        description: subject,
        expected: [],
      });
    }
    return ok(out);
  }

  private async git(args: readonly string[]): Promise<Result<string, MetatorError>> {
    const r = await this.d.runner.run({ argv: ["git", ...args], cwd: this.d.root }, { timeoutMs: 60_000 });
    if (r.exitCode !== 0)
      return err(
        new MetatorError(
          "INTERNAL",
          `git ${args.slice(0, 2).join(" ")} failed: ${r.stderr.trim() || r.exitCode}`,
        ),
      );
    return ok(r.stdout.replace(/\n$/, ""));
  }
}

/** The lines a `--unified=0` diff removes, per file: `@@ -start,count +… @@` under `--- a/<file>`. */
export function removedRanges(diff: string): { file: string; start: number; end: number }[] {
  const out: { file: string; start: number; end: number }[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      file = header[1] as string;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (!hunk || file === "") continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) out.push({ file, start, end: start + count - 1 });
  }
  return out;
}

/** `git blame --porcelain`: each line's commit and its line number in that commit's version of the file. */
export function blameLines(porcelain: string): [string, number][] {
  const out: [string, number][] = [];
  for (const line of porcelain.split("\n")) {
    const m = /^([0-9a-f]{40}) (\d+) \d+(?: \d+)?$/.exec(line);
    if (m) out.push([m[1] as string, Number(m[2])]);
  }
  return out;
}
