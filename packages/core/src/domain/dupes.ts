import { maskMarkdownCode } from "./memory.ts";

/**
 * Duplicate knowledge (memory map step 3, ADR-0026): the same statement written in several
 * files drifts apart. Sentences come from `Intl.Segmenter`; near duplicates are found with
 * Jaccard similarity on word 3-grams through an inverted index (no pairwise scan).
 */
export interface Sentence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly words: readonly string[];
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });

/** Markdown syntax that is not part of the statement itself. */
function plain(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images keep their text
    .replace(/\[\[cite:[^\]]*\]\]/g, " ") // citations are evidence, not statement
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*([-*+]|\d+\.|>)\s*/, "")
    .replace(/[*_~|]/g, " ");
}

/** YAML fields that hold prose; every other YAML line is structure (ids, globs, refs). */
const PROSE_KEYS =
  /^\s*(?:-\s*)?(?:summary|description|intent|title|when|whenNot|reason|message|rationale):\s*["']?(.+?)["']?\s*$/;

/** Statements of a knowledge file: prose only (no code, headings, tables or YAML structure). */
export function sentencesOf(file: string, text: string, minWords: number): Sentence[] {
  const yaml = /\.ya?ml$/i.test(file);
  // Markdown front matter is metadata (ids, routing descriptions), not statements; keep its lines empty.
  const body = /\.md$/i.test(file)
    ? text.replace(/^---\n[\s\S]*?\n---\n/, (fm) => fm.replace(/[^\n]/g, ""))
    : text;
  const source = /\.md$/i.test(file) ? maskMarkdownCode(body) : body;
  const out: Sentence[] = [];
  source.split("\n").forEach((raw, i) => {
    let line: string;
    if (yaml) {
      const value = PROSE_KEYS.exec(raw)?.[1];
      if (!value) return;
      line = value;
    } else {
      if (/^\s*(#{1,6}\s|\|)/.test(raw)) return; // headings name things; tables list them
      line = plain(raw);
    }
    for (const { segment } of sentenceSegmenter.segment(line)) {
      const words = [...wordSegmenter.segment(segment.toLowerCase())]
        .filter((w) => w.isWordLike)
        .map((w) => w.segment);
      if (words.length >= minWords) out.push({ file, line: i + 1, text: segment.trim(), words });
    }
  });
  return out;
}

export interface DuplicateGroup {
  readonly text: string;
  /** 1 for exact duplicates (after normalization), lower for near duplicates. */
  readonly similarity: number;
  readonly occurrences: readonly { readonly file: string; readonly line: number; readonly text: string }[];
}

const shingles = (words: readonly string[]) => {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= words.length; i++) out.add(words.slice(i, i + 3).join(" "));
  return out;
};

/** Groups sentences that appear in more than one file, exactly or with similarity ≥ threshold. */
export function findDuplicates(sentences: readonly Sentence[], threshold: number): DuplicateGroup[] {
  const sets = sentences.map((s) => shingles(s.words));
  const index = new Map<string, number[]>();
  sets.forEach((set, i) => {
    for (const sh of set) {
      const list = index.get(sh);
      if (list) list.push(i);
      else index.set(sh, [i]);
    }
  });

  // Union-find over sentence indexes: a group is everything connected by a similar pair.
  const parent = sentences.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] as number;
    return root;
  };
  const best = new Map<string, number>();
  sets.forEach((set, i) => {
    const shared = new Map<number, number>();
    for (const sh of set)
      for (const j of index.get(sh) ?? []) if (j > i) shared.set(j, (shared.get(j) ?? 0) + 1);
    for (const [j, common] of shared) {
      const similarity = common / (set.size + (sets[j]?.size ?? 0) - common);
      if (similarity < threshold) continue;
      const a = find(i);
      const b = find(j);
      parent[a] = b;
      best.set(`${i}:${j}`, similarity);
    }
  });

  const groups = new Map<number, number[]>();
  sentences.forEach((_, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  });
  const out: DuplicateGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const files = new Set(members.map((m) => sentences[m]?.file));
    if (files.size < 2) continue;
    let min = 1;
    for (const [key, s] of best) {
      const [i, j] = key.split(":").map(Number) as [number, number];
      if (members.includes(i) && members.includes(j)) min = Math.min(min, s);
    }
    const occurrences = members
      .map((m) => sentences[m] as Sentence)
      .map(({ file, line, text }) => ({ file, line, text }));
    occurrences.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    out.push({ text: occurrences[0]?.text ?? "", similarity: Math.round(min * 100) / 100, occurrences });
  }
  return out.sort(
    (a, b) =>
      b.occurrences.length - a.occurrences.length ||
      b.similarity - a.similarity ||
      a.text.localeCompare(b.text),
  );
}
