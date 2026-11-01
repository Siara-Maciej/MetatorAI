import { maskMarkdownCode } from "./memory.ts";

/**
 * Architecture decision records keep their community format (Nygard style: title, status
 * list item, Context / Decision / Consequences), so they are parsed, not stamped (ADR-0024).
 */
export type AdrStatus = "Proposed" | "Accepted" | "Deprecated" | "Superseded";

export interface ParsedAdr {
  readonly number?: number;
  readonly title?: string;
  readonly status?: AdrStatus;
  /** Raw status text, e.g. "Superseded by [ADR-0011](0011-di-awilix.md)". */
  readonly statusText?: string;
  /** ADR numbers the status line points at (superseded by). */
  readonly statusRefs: readonly number[];
  readonly date?: string;
  /** Level-2 headings, as written. */
  readonly sections: readonly string[];
  /** Canon rule ids mentioned outside code (e.g. in "Implications for code"). */
  readonly ruleRefs: readonly string[];
  /** Rule ids inside the implications section. */
  readonly implicationRuleRefs: readonly string[];
}

/** Section names in English and Polish (the two languages MetatorAI ships with). */
export const ADR_SECTIONS = {
  context: ["Context", "Kontekst"],
  decision: ["Decision", "Decyzja"],
  consequences: ["Consequences", "Konsekwencje"],
  implications: ["Implications for code", "Implikacje dla kodu"],
} as const;

const RULE_REF = /\b[A-Z][A-Z0-9]*-[A-Z][A-Z0-9]*-\d{3}\b/g;
// `- Status: X` (list item), `Status: X` or `**Status:** X` (bold label), as ADR tools write them.
const label = (names: string) => `^\\s*(?:[-*]\\s+)?(?:\\*\\*)?(?:${names})(?::\\*\\*|\\*\\*:|:)\\s*`;
const STATUS = new RegExp(`${label("Status")}(.+?)\\s*$`, "im");
const DATE = new RegExp(`${label("Date|Data")}(\\d{4}-\\d{2}-\\d{2})\\b`, "im");
/** `# ADR-0012: Title`, also `## ADR 012: Title` under a generic first heading. */
const TITLE = /^#{1,2}\s+ADR[- ]?(\d+):\s*(.+?)\s*$/m;

export function parseAdr(markdown: string): ParsedAdr {
  const text = maskMarkdownCode(markdown);
  const title = TITLE.exec(text);
  const statusText = STATUS.exec(text)?.[1];
  // "Draft" is how many logs say Proposed.
  const status = statusText?.toLowerCase().startsWith("draft")
    ? ("Proposed" as const)
    : (["Proposed", "Accepted", "Deprecated", "Superseded"] as const).find((s) =>
        statusText?.toLowerCase().startsWith(s.toLowerCase()),
      );
  const statusRefs = statusText
    ? [...statusText.matchAll(/ADR-(\d+)|\b(\d{4})\b/g)].map((m) => Number(m[1] ?? m[2]))
    : [];

  const sections: string[] = [];
  const implicationRuleRefs: string[] = [];
  let inImplications = false;
  for (const line of text.split("\n")) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading && !line.startsWith("###") && !TITLE.test(line)) {
      sections.push(heading);
      inImplications = (ADR_SECTIONS.implications as readonly string[]).some((s) => sameHeading(s, heading));
      continue;
    }
    if (inImplications) implicationRuleRefs.push(...(line.match(RULE_REF) ?? []));
  }
  return {
    ...(title ? { number: Number(title[1]), title: title[2] as string } : {}),
    ...(status ? { status } : {}),
    ...(statusText ? { statusText } : {}),
    statusRefs: [...new Set(statusRefs)],
    ...(DATE.exec(text)?.[1] ? { date: DATE.exec(text)?.[1] as string } : {}),
    sections,
    ruleRefs: [...new Set(text.match(RULE_REF) ?? [])].sort(),
    implicationRuleRefs: [...new Set(implicationRuleRefs)].sort(),
  };
}

export function sameHeading(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function hasSection(adr: ParsedAdr, names: readonly string[]): boolean {
  return adr.sections.some((s) => names.some((n) => sameHeading(n, s)));
}
