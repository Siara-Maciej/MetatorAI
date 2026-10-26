import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * Memory map (ADR-0021): the register of every knowledge carrier agents use, with its tier,
 * who writes and reads it, how it is loaded into context, and its size budget.
 */
export const TierSchema = z.enum(["T0", "T1", "T2", "T3", "T4", "T5"]);
export type Tier = z.output<typeof TierSchema>;

const Budget = z
  .strictObject({
    chars: z.number().int().positive().optional(),
    lines: z.number().int().positive().optional(),
    tokens: z.number().int().positive().optional(),
  })
  .refine((b) => b.chars ?? b.lines ?? b.tokens, "set at least one of chars, lines, tokens");
export type Budget = z.output<typeof Budget>;

const Load = z
  .string()
  .regex(
    /^(always|explicit|applyTo:.+|skill:.+|query:.+)$/,
    "expected always | explicit | applyTo:<glob> | skill:<name> | query:<command>",
  );

export const MemoryItemSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, "expected a lower-case id, e.g. t1.rules"),
  tier: TierSchema,
  kind: z.enum(["canon", "derived", "working", "learned", "external"]),
  /** Repo-relative globs of the files this item covers (not needed for external memory). */
  paths: z.array(z.string().min(1)).default([]),
  load: Load,
  writers: z.array(z.string()).min(1),
  readers: z.array(z.string()).min(1),
  /** Limit for every single file of the item. */
  budget: Budget.optional(),
  /** Whether `[[cite: …]]` claims in these files are validated (default: canon and learned). */
  citations: z.boolean().optional(),
  description: z.string().optional(),
});
export type MemoryItem = z.output<typeof MemoryItemSchema>;

export const DEFAULT_KNOWLEDGE_GLOBS: readonly string[] = [
  "**/AGENTS.md",
  "**/CLAUDE.md",
  ".github/copilot-instructions.md",
  ".github/instructions/**",
  ".github/agents/**",
  ".github/prompts/**",
  ".github/skills/**",
  ".github/metator/**",
  ".claude/**/*.md",
  "docs/**",
];

export const MemoryMapSchema = z.strictObject({
  /** Files that count as knowledge; each must be covered by an item (`memory check`). */
  knowledge: z
    .strictObject({
      include: z.array(z.string()).default([...DEFAULT_KNOWLEDGE_GLOBS]),
      exclude: z.array(z.string()).default([]),
    })
    .default({ include: [...DEFAULT_KNOWLEDGE_GLOBS], exclude: [] }),
  /** Aggregate budgets per tier (e.g. everything always loaded, T0, ≤ 4000 chars). */
  tierBudgets: z.partialRecord(TierSchema, Budget).default({}),
  items: z.array(MemoryItemSchema).min(1),
});
export type MemoryMap = z.output<typeof MemoryMapSchema>;

export const MemoryMapDocument = defineDocument("MemoryMap", {
  latest: MemoryMapSchema,
  errorCode: "INVALID_CONFIG",
  hint: "Fix the listed issues; `metator memory schema` prints the JSON Schema.",
});

export function citationsEnabled(item: MemoryItem): boolean {
  return item.citations ?? (item.kind === "canon" || item.kind === "learned");
}

export interface Size {
  readonly chars: number;
  readonly lines: number;
  readonly tokens: number;
}

export function sizeOf(text: string): Size {
  const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return { chars: text.length, lines, tokens: Math.ceil(text.length / 4) };
}

/** The budget dimensions a size exceeds, e.g. ["chars 5200 > 4000"]. */
export function overBudget(size: Size, budget: Budget): string[] {
  const over: string[] = [];
  for (const key of ["chars", "lines", "tokens"] as const) {
    const limit = budget[key];
    if (limit !== undefined && size[key] > limit) over.push(`${key} ${size[key]} > ${limit}`);
  }
  return over;
}

// ── citations ───────────────────────────────────────────────────────────────────

/** `[[cite: packages/billing/src/invoice.ts:41 | "if (amount < 0) throw"]]` */
const CITATION = /\[\[cite:\s*([^\s|\]]+?):(\d+)\s*\|\s*"((?:[^"\\]|\\.)*)"\s*\]\]/g;

export interface Citation {
  readonly path: string;
  readonly line: number;
  readonly quote: string;
  /** Where the citation sits in the citing document (1-based line). */
  readonly at: number;
  /** The exact citation text, for in-place fixes. */
  readonly raw: string;
}

/**
 * Citations in a document. In Markdown, citations inside fenced code blocks and code spans are
 * examples, not claims, so code is masked first (same length, newlines kept: positions stay true).
 */
export function parseCitations(text: string, options: { readonly markdown?: boolean } = {}): Citation[] {
  const scanned = options.markdown ? maskMarkdownCode(text) : text;
  const out: Citation[] = [];
  for (const m of scanned.matchAll(CITATION)) {
    out.push({
      path: m[1] as string,
      line: Number(m[2]),
      quote: (m[3] as string).replace(/\\(.)/g, "$1"),
      at: text.slice(0, m.index).split("\n").length,
      raw: m[0],
    });
  }
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Replaces fenced code blocks and code spans with spaces, keeping every newline and offset. */
export function maskMarkdownCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let fence: string | undefined;
  const lines = text.split("\n").map((line) => {
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = undefined;
      return blank(line);
    }
    if (f) {
      fence = f;
      return blank(line);
    }
    return line.replace(/(`+)[^`]*?\1/g, blank);
  });
  return lines.join("\n");
}

export function renderCitation(c: { path: string; line: number; quote: string }): string {
  return `[[cite: ${c.path}:${c.line} | "${c.quote.replace(/["\\]/g, "\\$&")}"]]`;
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

export const CITATION_WINDOW = 10;

export type QuoteMatch =
  | { readonly status: "ok"; readonly line: number }
  | { readonly status: "moved"; readonly line: number }
  | { readonly status: "stale" };

/**
 * Finds a quote in a file: at the cited line, within ±10 lines (nearest wins), or as a unique
 * match anywhere in the file. Whitespace is normalized; a quote may span lines.
 */
export function locateQuote(content: string, line: number, quote: string): QuoteMatch {
  const q = normalize(quote);
  if (q === "") return { status: "stale" };
  const lines = content.split("\n");
  const span = quote.split("\n").length + 2;
  const from = (l: number) => normalize(lines.slice(l - 1, l - 1 + span).join(" "));
  // The quote starts at l: it is on line l itself, or it needs line l to be complete.
  const startsAt = (l: number) =>
    l >= 1 &&
    l <= lines.length &&
    from(l).includes(q) &&
    (normalize(lines[l - 1] as string).includes(q) || !from(l + 1).includes(q));

  if (startsAt(line)) return { status: "ok", line };
  for (let d = 1; d <= CITATION_WINDOW; d++) {
    for (const l of [line - d, line + d]) if (startsAt(l)) return { status: "moved", line: l };
  }
  const anywhere = lines.map((_, i) => i + 1).filter(startsAt);
  return anywhere.length === 1 ? { status: "moved", line: anywhere[0] as number } : { status: "stale" };
}

// ── access matrix ───────────────────────────────────────────────────────────────

export type Access = "R" | "W" | "RW";

export interface AccessMatrix {
  readonly agents: readonly string[];
  readonly items: readonly string[];
  /** agent → item id → access; missing means none. `*` readers grant every agent read access. */
  readonly access: Readonly<Record<string, Readonly<Record<string, Access>>>>;
  readonly markdown: string;
}

/** Writer and reader names without annotations: "mt-retro(HITL)" → "mt-retro". */
const actor = (name: string) => name.replace(/\s*\(.*\)\s*$/, "").trim();

/** Who reads and writes which memory (memory map step 8), as data for hooks and as a table. */
export function accessMatrix(map: MemoryMap): AccessMatrix {
  const agents = new Set<string>();
  for (const item of map.items)
    for (const n of [...item.readers, ...item.writers]) if (n !== "*") agents.add(actor(n));
  const sortedAgents = [...agents].sort();
  const access: Record<string, Record<string, Access>> = {};
  for (const agent of sortedAgents) {
    access[agent] = {};
    for (const item of map.items) {
      const reads = item.readers.includes("*") || item.readers.map(actor).includes(agent);
      const writes = item.writers.map(actor).includes(agent);
      if (reads || writes)
        (access[agent] as Record<string, Access>)[item.id] = reads && writes ? "RW" : writes ? "W" : "R";
    }
  }
  const items = map.items.map((i) => i.id);
  const header = `| Agent | ${items.join(" | ")} |`;
  const rule = `|${"---|".repeat(items.length + 1)}`;
  const rows = sortedAgents.map((a) => `| ${a} | ${items.map((i) => access[a]?.[i] ?? "–").join(" | ")} |`);
  return { agents: sortedAgents, items, access, markdown: [header, rule, ...rows].join("\n") };
}
