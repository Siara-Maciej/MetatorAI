import { type DuplicateGroup, findDuplicates, type Sentence, sentencesOf } from "../domain/dupes.ts";
import { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import {
  citationsEnabled,
  DEFAULT_KNOWLEDGE_GLOBS,
  locateQuote,
  type MemoryItem,
  type MemoryMap,
  MemoryMapDocument,
  overBudget,
  parseCitations,
  renderCitation,
  type Size,
  sizeOf,
  type Tier,
} from "../domain/memory.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseYamlDocument, readFrontMatter } from "../domain/versioned.ts";
import type { FileSystem, ReadonlyFileSystem } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";
import type { SourceFiles } from "./source-files.ts";

export interface LoadedMemoryMap {
  readonly map: MemoryMap;
  readonly source: string;
}

/** Reads `paths.memoryMap`; a repository without one is NOT_FOUND with a hint. */
export class MemoryMapReader {
  constructor(
    private readonly fs: ReadonlyFileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async load(): Promise<Result<LoadedMemoryMap, MetatorError>> {
    const source = this.paths.memoryMap;
    const text = await this.fs.read(source);
    if (text.isErr()) {
      return err(
        new MetatorError("NOT_FOUND", `No memory map at ${source}`, {
          hint: "Run `metator memory inventory` to see the knowledge files, then write the map (`metator memory schema`).",
        }),
      );
    }
    return parseYamlDocument(text.value, source)
      .andThen((raw) => MemoryMapDocument.parse(raw, source))
      .map((map) => ({ map, source }));
  }

  /** The map when present; `undefined` when the repository has none (inventory works without). */
  async optional(): Promise<Result<LoadedMemoryMap | undefined, MetatorError>> {
    if (!(await this.fs.exists(this.paths.memoryMap))) return ok(undefined);
    return this.load();
  }
}

/** Which map item covers a file (first match wins; overlaps are reported by `memory check`). */
export function itemFor(map: MemoryMap | undefined, file: string): MemoryItem | undefined {
  return map?.items.find((item) => item.paths.length > 0 && matchesAny(file, item.paths));
}

// ── memory inventory ────────────────────────────────────────────────────────────

export interface InventoryEntry {
  readonly path: string;
  readonly item?: string;
  readonly tier?: Tier;
  readonly size: Size;
  /** Host-relevant front matter (e.g. Copilot `applyTo`, agent `description`). */
  readonly frontMatter?: Readonly<Record<string, unknown>>;
}

export interface MemoryInventory {
  readonly mapped: boolean;
  readonly files: readonly InventoryEntry[];
  readonly unmapped: readonly string[];
  readonly totals: Readonly<Partial<Record<Tier | "unmapped", Size & { readonly files: number }>>>;
}

/** Step 1 of the memory map: every knowledge file with its size and current classification. */
export class InventoryMemory {
  constructor(
    private readonly reader: MemoryMapReader,
    private readonly knowledge: KnowledgeFiles,
    private readonly fs: ReadonlyFileSystem,
  ) {}

  async execute(): Promise<Result<MemoryInventory, MetatorError>> {
    const loaded = await this.reader.optional();
    if (loaded.isErr()) return err(loaded.error);
    const map = loaded.value?.map;
    const files = await this.knowledge.list(map);
    if (files.isErr()) return err(files.error);

    const entries: InventoryEntry[] = [];
    const totals: Partial<
      Record<Tier | "unmapped", { chars: number; lines: number; tokens: number; files: number }>
    > = {};
    for (const path of files.value) {
      const text = await this.fs.read(path);
      if (text.isErr()) continue;
      const item = itemFor(map, path);
      const size = sizeOf(text.value);
      const frontMatter = path.endsWith(".md") ? hostFrontMatter(text.value, path) : undefined;
      entries.push({
        path,
        ...(item ? { item: item.id, tier: item.tier } : {}),
        size,
        ...(frontMatter ? { frontMatter } : {}),
      });
      const key = item?.tier ?? "unmapped";
      const t = totals[key] ?? { chars: 0, lines: 0, tokens: 0, files: 0 };
      totals[key] = t;
      t.chars += size.chars;
      t.lines += size.lines;
      t.tokens += size.tokens;
      t.files++;
    }
    return ok({
      mapped: map !== undefined,
      files: entries,
      unmapped: entries.filter((e) => !e.item).map((e) => e.path),
      totals,
    });
  }
}

function hostFrontMatter(text: string, path: string): Record<string, unknown> | undefined {
  if (!text.startsWith("---\n")) return undefined;
  const fm = readFrontMatter(text, path);
  if (fm.isErr() || typeof fm.value !== "object" || fm.value === null) return undefined;
  const picked = Object.fromEntries(
    Object.entries(fm.value).filter(([k]) => ["kind", "applyTo", "description", "name", "tools"].includes(k)),
  );
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** Knowledge files as git sees them (or the file system), selected by the map's globs. */
export class KnowledgeFiles {
  constructor(private readonly sources: SourceFiles) {}

  async list(map: MemoryMap | undefined): Promise<Result<readonly string[], MetatorError>> {
    const include = map?.knowledge.include ?? DEFAULT_KNOWLEDGE_GLOBS;
    const exclude = map?.knowledge.exclude ?? [];
    return (await this.sources.list()).map((files) =>
      files.filter((f) => matchesAny(f, include) && !(exclude.length > 0 && matchesAny(f, exclude))).sort(),
    );
  }
}

// ── memory budget ───────────────────────────────────────────────────────────────

export interface BudgetReport {
  readonly items: readonly {
    readonly id: string;
    readonly files: number;
    readonly over: readonly {
      readonly path: string;
      readonly size: Size;
      readonly over: readonly string[];
    }[];
  }[];
  readonly tiers: readonly {
    readonly tier: Tier;
    readonly size: Size;
    readonly files: number;
    readonly over: readonly string[];
  }[];
  readonly overBudget: number;
}

/** Sizes against the budgets of the map: per file of an item, and in total per tier. */
export class MemoryBudget {
  constructor(
    private readonly reader: MemoryMapReader,
    private readonly fs: ReadonlyFileSystem,
  ) {}

  async execute(): Promise<Result<BudgetReport, MetatorError>> {
    const loaded = await this.reader.load();
    if (loaded.isErr()) return err(loaded.error);
    const { map } = loaded.value;

    const items: BudgetReport["items"][number][] = [];
    const tierFiles = new Map<Tier, Map<string, Size>>();
    for (const item of map.items) {
      const files = item.paths.length > 0 ? await this.fs.glob(item.paths) : [];
      const over: { path: string; size: Size; over: string[] }[] = [];
      for (const path of files) {
        const text = await this.fs.read(path);
        if (text.isErr()) continue;
        const size = sizeOf(text.value);
        const byTier = tierFiles.get(item.tier) ?? new Map<string, Size>();
        byTier.set(path, size);
        tierFiles.set(item.tier, byTier);
        const exceeded = item.budget ? overBudget(size, item.budget) : [];
        if (exceeded.length > 0) over.push({ path, size, over: exceeded });
      }
      items.push({ id: item.id, files: files.length, over });
    }

    const tiers: BudgetReport["tiers"][number][] = [];
    for (const [tier, files] of [...tierFiles].sort(([a], [b]) => a.localeCompare(b))) {
      const size = [...files.values()].reduce(
        (sum, s) => ({
          chars: sum.chars + s.chars,
          lines: sum.lines + s.lines,
          tokens: sum.tokens + s.tokens,
        }),
        { chars: 0, lines: 0, tokens: 0 },
      );
      const budget = map.tierBudgets[tier];
      tiers.push({ tier, size, files: files.size, over: budget ? overBudget(size, budget) : [] });
    }
    const overCount =
      items.reduce((n, i) => n + i.over.length, 0) + tiers.filter((t) => t.over.length > 0).length;
    return ok({ items, tiers, overBudget: overCount });
  }
}

// ── memory validate ─────────────────────────────────────────────────────────────

export interface CitationResult {
  readonly file: string;
  /** Line of the citation in the citing file. */
  readonly at: number;
  readonly cites: string;
  readonly status: "ok" | "moved" | "fixed" | "stale" | "missing-file";
  readonly line?: number;
}

export interface ValidationReport {
  readonly files: number;
  readonly citations: readonly CitationResult[];
  readonly counts: Readonly<Record<CitationResult["status"], number>>;
}

/**
 * Checks `[[cite: path:line | "quote"]]` claims in canon and learned memory: the file exists and
 * the quote is at the line. A quote that moved gets its line updated with `fix`; one that is gone
 * is `stale` (the claim must be re-verified by a human or the curator).
 */
export class ValidateCitations {
  constructor(
    private readonly reader: MemoryMapReader,
    private readonly fs: FileSystem,
  ) {}

  async execute(input: { readonly fix: boolean }): Promise<Result<ValidationReport, MetatorError>> {
    const loaded = await this.reader.load();
    if (loaded.isErr()) return err(loaded.error);
    const files = new Set<string>();
    for (const item of loaded.value.map.items.filter(citationsEnabled)) {
      if (item.paths.length > 0) for (const f of await this.fs.glob(item.paths)) files.add(f);
    }

    const results: CitationResult[] = [];
    for (const file of [...files].sort()) {
      const text = await this.fs.read(file);
      if (text.isErr()) continue;
      let updated = text.value;
      for (const c of parseCitations(text.value, { markdown: /\.md$/i.test(file) })) {
        const cites = `${c.path}:${c.line}`;
        const target = await this.fs.read(c.path);
        if (target.isErr()) {
          results.push({ file, at: c.at, cites, status: "missing-file" });
          continue;
        }
        const match = locateQuote(target.value, c.line, c.quote);
        if (match.status === "stale") results.push({ file, at: c.at, cites, status: "stale" });
        else if (match.status === "ok")
          results.push({ file, at: c.at, cites, status: "ok", line: match.line });
        else {
          if (input.fix) updated = updated.replace(c.raw, renderCitation({ ...c, line: match.line }));
          results.push({ file, at: c.at, cites, status: input.fix ? "fixed" : "moved", line: match.line });
        }
      }
      if (updated !== text.value) {
        const saved = await this.fs.write(file, updated);
        if (saved.isErr()) return err(saved.error);
      }
    }
    const counts = { ok: 0, moved: 0, fixed: 0, stale: 0, "missing-file": 0 };
    for (const r of results) counts[r.status]++;
    return ok({ files: files.size, citations: results, counts });
  }
}

// ── memory check ────────────────────────────────────────────────────────────────

export interface MemoryProblem {
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly path?: string;
  readonly item?: string;
}

export interface MemoryCheckReport {
  readonly items: number;
  readonly knowledgeFiles: number;
  readonly problems: readonly MemoryProblem[];
}

/** CI guard: every knowledge file is mapped, budgets hold, citations are true. */
export class CheckMemory {
  constructor(
    private readonly reader: MemoryMapReader,
    private readonly knowledge: KnowledgeFiles,
    private readonly fs: ReadonlyFileSystem,
    private readonly budget: MemoryBudget,
    private readonly citations: ValidateCitations,
  ) {}

  async execute(): Promise<Result<MemoryCheckReport, MetatorError>> {
    const loaded = await this.reader.load();
    if (loaded.isErr()) return err(loaded.error);
    const { map } = loaded.value;
    const problems: MemoryProblem[] = [];

    const ids = new Set<string>();
    for (const item of map.items) {
      if (ids.has(item.id))
        problems.push({ severity: "error", item: item.id, message: `duplicate item id ${item.id}` });
      ids.add(item.id);
      if (item.paths.length > 0 && (await this.fs.glob(item.paths)).length === 0) {
        problems.push({
          severity: "warning",
          item: item.id,
          message: `paths match no file: ${item.paths.join(", ")}`,
        });
      }
    }

    const files = await this.knowledge.list(map);
    if (files.isErr()) return err(files.error);
    for (const path of files.value) {
      const covering = map.items.filter((i) => i.paths.length > 0 && matchesAny(path, i.paths));
      if (covering.length === 0) {
        problems.push({
          severity: "error",
          path,
          message: "knowledge file is not covered by any memory map item",
        });
      } else if (covering.length > 1) {
        problems.push({
          severity: "warning",
          path,
          message: `covered by several items (${covering.map((i) => i.id).join(", ")}); the first one wins`,
        });
      }
    }

    const budget = await this.budget.execute();
    if (budget.isErr()) return err(budget.error);
    for (const item of budget.value.items) {
      for (const o of item.over) {
        problems.push({
          severity: "error",
          item: item.id,
          path: o.path,
          message: `over budget: ${o.over.join(", ")}`,
        });
      }
    }
    for (const t of budget.value.tiers.filter((x) => x.over.length > 0)) {
      problems.push({ severity: "error", message: `tier ${t.tier} over budget: ${t.over.join(", ")}` });
    }

    const cites = await this.citations.execute({ fix: false });
    if (cites.isErr()) return err(cites.error);
    for (const c of cites.value.citations) {
      if (c.status === "stale" || c.status === "missing-file") {
        problems.push({
          severity: "error",
          path: c.file,
          message: `line ${c.at}: citation ${c.cites} is ${c.status === "stale" ? "stale (quote not found)" : "to a missing file"}`,
        });
      } else if (c.status === "moved") {
        problems.push({
          severity: "warning",
          path: c.file,
          message: `line ${c.at}: citation ${c.cites} moved to line ${c.line}; run \`metator memory validate --fix\``,
        });
      }
    }
    return ok({ items: map.items.length, knowledgeFiles: files.value.length, problems });
  }
}

// ── memory dupes ────────────────────────────────────────────────────────────────

export interface DupesReport {
  readonly files: number;
  readonly sentences: number;
  readonly groups: readonly (Omit<DuplicateGroup, "occurrences"> & {
    /** Where the statement should live: the canon occurrence, when there is one. */
    readonly keep?: string;
    readonly occurrences: readonly {
      readonly file: string;
      readonly line: number;
      readonly text: string;
      readonly tier?: Tier;
    }[];
  })[];
}

/**
 * The same statement in several knowledge files (memory map step 3). Generated (derived)
 * copies are skipped: they are duplicates by design and kept in sync by their generator.
 */
export class FindMemoryDupes {
  constructor(
    private readonly reader: MemoryMapReader,
    private readonly knowledge: KnowledgeFiles,
    private readonly fs: ReadonlyFileSystem,
  ) {}

  async execute(input: {
    readonly minWords: number;
    readonly threshold: number;
  }): Promise<Result<DupesReport, MetatorError>> {
    const loaded = await this.reader.optional();
    if (loaded.isErr()) return err(loaded.error);
    const map = loaded.value?.map;
    const files = await this.knowledge.list(map);
    if (files.isErr()) return err(files.error);

    const sentences: Sentence[] = [];
    let scanned = 0;
    for (const file of files.value) {
      if (itemFor(map, file)?.kind === "derived") continue;
      const text = await this.fs.read(file);
      if (text.isErr()) continue;
      scanned++;
      sentences.push(...sentencesOf(file, text.value, input.minWords));
    }
    const groups = findDuplicates(sentences, input.threshold).map((g) => {
      const occurrences = g.occurrences.map(
        (o): { file: string; line: number; text: string; tier?: Tier } => {
          const tier = itemFor(map, o.file)?.tier;
          return tier ? { ...o, tier } : { ...o };
        },
      );
      const canon = occurrences.find((o) => itemFor(map, o.file)?.kind === "canon" && o.tier === "T1");
      return { ...g, occurrences, ...(canon ? { keep: canon.file } : {}) };
    });
    return ok({ files: scanned, sentences: sentences.length, groups });
  }
}
