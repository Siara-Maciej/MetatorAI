import { ADR_SECTIONS, hasSection, type ParsedAdr, parseAdr } from "../domain/adr.ts";
import type { MetatorError } from "../domain/errors.ts";
import { ok, type Result } from "../domain/result.ts";
import type { ReadonlyFileSystem } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";
import type { RuleCatalog } from "./rules.ts";

export interface AdrProblem {
  readonly file: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface AdrLintReport {
  readonly adrs: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly problems: readonly AdrProblem[];
}

const FILE = /^(\d{4})-[a-z0-9][a-z0-9-]*\.md$/;
const INDEX_NAMES = ["README.md", "index.md"];

/**
 * Lints the decision log: numbering, title, status (and what supersedes it), required
 * sections, and the ADR → rule chain: an Accepted ADR names the canon rules it implies.
 */
export class LintAdrs {
  constructor(
    private readonly fs: ReadonlyFileSystem,
    private readonly paths: MetatorPaths,
    private readonly rules: RuleCatalog,
  ) {}

  async execute(): Promise<Result<AdrLintReport, MetatorError>> {
    const dir = this.paths.adr;
    const files = (await this.fs.glob([`${dir}/*.md`])).filter(
      (f) => !INDEX_NAMES.includes(f.slice(dir.length + 1)),
    );
    const canon = new Set((await this.rules.scan()).rules.map((r) => r.rule.id));
    const problems: AdrProblem[] = [];
    const parsed = new Map<number, { file: string; adr: ParsedAdr }>();

    for (const file of [...files].sort()) {
      const error = (message: string) => problems.push({ file, severity: "error", message });
      const name = file.slice(dir.length + 1);
      const numbered = FILE.exec(name);
      if (!numbered) {
        error("file name must be NNNN-short-title.md");
        continue;
      }
      const text = await this.fs.read(file);
      if (text.isErr()) continue;
      const adr = parseAdr(text.value);
      const number = Number(numbered[1]);
      const first = parsed.get(number);
      if (first) error(`number ${numbered[1]} is already used by ${first.file}`);
      else parsed.set(number, { file, adr });

      if (adr.number === undefined) error(`missing title "# ADR-${numbered[1]}: <title>"`);
      else if (adr.number !== number) error(`title says ADR-${adr.number}, file name says ${numbered[1]}`);
      if (!adr.status) {
        error(
          `missing or unknown status (expected "- Status: Proposed | Accepted | Deprecated | Superseded by ADR-NNNN")`,
        );
      }
      if (!adr.date) problems.push({ file, severity: "warning", message: 'missing "- Date: YYYY-MM-DD"' });
      for (const [key, names] of Object.entries(ADR_SECTIONS)) {
        if (key !== "implications" && !hasSection(adr, names))
          error(`missing section "## ${names.join('" or "## ')}"`);
      }
      if (adr.status === "Accepted") {
        if (!hasSection(adr, ADR_SECTIONS.implications)) {
          error(
            `Accepted ADRs need "## ${ADR_SECTIONS.implications.join('" or "## ')}" naming the rules they imply`,
          );
        } else if (adr.implicationRuleRefs.length === 0) {
          error("the implications section names no canon rule id");
        }
      }
      for (const id of adr.ruleRefs) if (!canon.has(id)) error(`references unknown rule ${id}`);
    }

    for (const { file, adr } of parsed.values()) {
      if (adr.status !== "Superseded") continue;
      const targets = adr.statusRefs.filter((n) => n !== adr.number);
      if (targets.length === 0)
        problems.push({ file, severity: "error", message: "superseded by which ADR? name it" });
      for (const n of targets) {
        if (!parsed.has(n))
          problems.push({
            file,
            severity: "error",
            message: `superseded by ADR-${String(n).padStart(4, "0")}, which does not exist`,
          });
      }
    }

    await this.lintIndex(dir, parsed, problems);
    const byStatus: Record<string, number> = {};
    for (const { adr } of parsed.values())
      byStatus[adr.status ?? "unknown"] = (byStatus[adr.status ?? "unknown"] ?? 0) + 1;
    return ok({ adrs: parsed.size, byStatus, problems });
  }

  /** The index (README.md) links every ADR, and each row shows the ADR's current status. */
  private async lintIndex(
    dir: string,
    parsed: Map<number, { file: string; adr: ParsedAdr }>,
    problems: AdrProblem[],
  ): Promise<void> {
    for (const name of INDEX_NAMES) {
      const file = `${dir}/${name}`;
      const text = await this.fs.read(file);
      if (text.isErr()) continue;
      const rows = text.value.split("\n");
      for (const { file: adrFile, adr } of parsed.values()) {
        const base = adrFile.slice(dir.length + 1);
        const row = rows.find((r) => r.includes(`](${base})`) || r.includes(`](./${base})`));
        if (!row) {
          problems.push({ file, severity: "error", message: `does not link ${base}` });
        } else if (adr.status && !row.toLowerCase().includes(adr.status.toLowerCase())) {
          problems.push({
            file,
            severity: "error",
            message: `row for ${base} does not show its status ${adr.status}`,
          });
        }
      }
      for (const m of text.value.matchAll(/\]\((?:\.\/)?(\d{4}-[^)#]+\.md)\)/g)) {
        if (!parsed.has(Number((m[1] as string).slice(0, 4)))) {
          problems.push({ file, severity: "error", message: `links ${m[1]}, which does not exist` });
        }
      }
      return;
    }
  }
}
