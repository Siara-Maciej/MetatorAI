import type { MetatorError } from "../domain/errors.ts";
import {
  type Finding,
  type FindingSet,
  FindingSetDocument,
  mergeFindings,
  policyProblems,
} from "../domain/finding.ts";
import { locateQuote } from "../domain/memory.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { FileSystem } from "../ports/index.ts";

export interface FindingVerdict {
  readonly id: string;
  readonly source: string;
  readonly status: "valid" | "moved" | "fixed" | "invalid";
  readonly reasons: readonly string[];
  /** The line the quote is really on, when it moved. */
  readonly line?: number;
}

export interface FindingsReport {
  readonly files: number;
  readonly findings: readonly FindingVerdict[];
  readonly counts: Readonly<Record<FindingVerdict["status"], number>>;
  /** Files that are not valid FindingSet documents. */
  readonly unreadable: readonly { readonly source: string; readonly message: string }[];
}

const MERGED = "merged.json";

/**
 * `findings validate`: schema, policy (blocking needs trigger, reachability, evidence) and the
 * quote checked against the code (the same matcher as memory citations). A finding whose quote
 * is not in the file is invalid: it never reaches Verify.
 */
export class ValidateFindings {
  constructor(private readonly fs: FileSystem) {}

  async execute(input: {
    readonly dir: string;
    readonly fix: boolean;
  }): Promise<Result<FindingsReport, MetatorError>> {
    const sets = await loadSets(this.fs, input.dir);
    const verdicts: FindingVerdict[] = [];
    for (const { source, set } of sets.sets) {
      const updated: Finding[] = [];
      for (const f of set.findings) {
        const verdict = await this.check(f, source, input.fix);
        verdicts.push(verdict);
        updated.push(
          verdict.status === "fixed" && verdict.line
            ? { ...f, location: { ...f.location, line: verdict.line } }
            : f,
        );
      }
      if (input.fix && verdicts.some((v) => v.source === source && v.status === "fixed")) {
        const saved = await this.fs.write(
          source,
          serializeJsonDocument(FindingSetDocument.stamp({ ...set, findings: updated })),
        );
        if (saved.isErr()) return err(saved.error);
      }
    }
    const counts = { valid: 0, moved: 0, fixed: 0, invalid: 0 };
    for (const v of verdicts) counts[v.status]++;
    return ok({ files: sets.sets.length, findings: verdicts, counts, unreadable: sets.unreadable });
  }

  private async check(f: Finding, source: string, fix: boolean): Promise<FindingVerdict> {
    const reasons = policyProblems(f);
    const code = await this.fs.read(f.location.file);
    if (code.isErr())
      return {
        id: f.id,
        source,
        status: "invalid",
        reasons: [...reasons, `file not found: ${f.location.file}`],
      };
    const match = locateQuote(code.value, f.location.line, f.quote);
    if (match.status === "stale") reasons.push(`quote not found in ${f.location.file}`);
    if (reasons.length > 0) return { id: f.id, source, status: "invalid", reasons };
    if (match.status === "moved")
      return { id: f.id, source, status: fix ? "fixed" : "moved", reasons: [], line: match.line };
    return { id: f.id, source, status: "valid", reasons: [] };
  }
}

export interface MergeReport {
  readonly input: number;
  readonly dropped: readonly string[];
  readonly duplicates: number;
  readonly merged: number;
  readonly output: string;
}

/** `findings merge`: valid findings only, one per root cause across lenses, in `<dir>/merged.json`. */
export class MergeFindingSets {
  constructor(
    private readonly fs: FileSystem,
    private readonly validate: ValidateFindings,
  ) {}

  async execute(input: { readonly dir: string }): Promise<Result<MergeReport, MetatorError>> {
    const report = await this.validate.execute({ dir: input.dir, fix: true });
    if (report.isErr()) return err(report.error);
    const invalid = new Set(
      report.value.findings.filter((v) => v.status === "invalid").map((v) => `${v.source}\u0000${v.id}`),
    );
    const sets = await loadSets(this.fs, input.dir);
    const kept = sets.sets.flatMap(({ source, set }) =>
      set.findings.filter((f) => !invalid.has(`${source}\u0000${f.id}`)),
    );
    const { merged, duplicates } = mergeFindings(kept);
    const output = `${input.dir.replace(/\/$/, "")}/${MERGED}`;
    // A workflow that resumes runs merge again: the verifications already recorded for the same
    // finding (id, file and quote) stay, so the verify stage is not lost.
    const verified = await this.verifications(output);
    const findings = merged.map((f) => {
      const v = verified.get(sameFinding(f));
      return v && !f.verification ? { ...f, verification: v } : f;
    });
    const saved = await this.fs.write(
      output,
      serializeJsonDocument(FindingSetDocument.stamp({ lens: "merged", findings })),
    );
    if (saved.isErr()) return err(saved.error);
    return ok({
      input: kept.length + invalid.size,
      dropped: [...invalid].map((k) => k.split("\u0000")[1] as string),
      duplicates,
      merged: merged.length,
      output,
    });
  }

  private async verifications(path: string): Promise<Map<string, NonNullable<Finding["verification"]>>> {
    const out = new Map<string, NonNullable<Finding["verification"]>>();
    const text = await this.fs.read(path);
    if (text.isErr()) return out;
    const set = parseJsonDocument(text.value, path).andThen((raw) => FindingSetDocument.parse(raw, path));
    if (set.isErr()) return out; // an unreadable previous merge is replaced, not trusted
    for (const f of set.value.findings) if (f.verification) out.set(sameFinding(f), f.verification);
    return out;
  }
}

const sameFinding = (f: Finding) => `${f.id}\u0000${f.location.file}\u0000${f.quote}`;

async function loadSets(
  fs: FileSystem,
  dir: string,
): Promise<{
  sets: { source: string; set: FindingSet }[];
  unreadable: { source: string; message: string }[];
}> {
  const files = (await fs.glob([`${dir.replace(/\/$/, "")}/*.json`]))
    .filter((f) => !f.endsWith(`/${MERGED}`))
    .sort();
  const sets: { source: string; set: FindingSet }[] = [];
  const unreadable: { source: string; message: string }[] = [];
  for (const source of files) {
    const parsed = (await fs.read(source))
      .andThen((t) => parseJsonDocument(t, source))
      .andThen((raw) => FindingSetDocument.parse(raw, source));
    if (parsed.isOk()) sets.push({ source, set: parsed.value });
    else {
      const issue = (parsed.error.details?.issues as { path: string }[] | undefined)?.[0];
      unreadable.push({
        source,
        message: issue ? `${parsed.error.message} (at ${issue.path})` : parsed.error.message,
      });
    }
  }
  return { sets, unreadable };
}
