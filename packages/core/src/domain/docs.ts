import { z } from "zod";
import { maskMarkdownCode } from "./memory.ts";
import { defineDocument } from "./versioned.ts";

/**
 * Documentation checks (`docs links|inventory|drift`, ADR-0045): links between repository files
 * and claims about the code that W7 (`mt-docs-curator`) verified once and CI keeps verifying.
 */
export interface MarkdownLink {
  readonly target: string;
  /** 1-based line in the document. */
  readonly line: number;
}

const INLINE = /!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/;

/** Inline links, images and reference definitions outside code blocks and code spans. */
export function markdownLinks(markdown: string): MarkdownLink[] {
  const out: MarkdownLink[] = [];
  maskMarkdownCode(markdown)
    .split("\n")
    .forEach((text, i) => {
      for (const m of text.matchAll(INLINE)) out.push({ target: m[1] as string, line: i + 1 });
      const def = DEFINITION.exec(text)?.[1];
      if (def) out.push({ target: def, line: i + 1 });
    });
  return out;
}

export type LinkTarget =
  | { readonly type: "external" }
  | { readonly type: "file"; readonly path: string; readonly anchor?: string };

/** `%20` → space; a malformed escape is kept as written. */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Where a link points, relative to the linking document (`/x` is relative to the repository root). */
export function resolveLink(from: string, target: string): LinkTarget {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return { type: "external" };
  const hash = target.indexOf("#");
  const rawPath = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? undefined : decode(target.slice(hash + 1));
  const decoded = decode(rawPath.split("?")[0] as string);
  const base = decoded.startsWith("/") ? "" : from.slice(0, from.lastIndexOf("/") + 1);
  const parts: string[] = [];
  for (const p of `${base}${decoded.replace(/^\/+/, "")}`.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== "." && p !== "") parts.push(p);
  }
  const path = decoded === "" ? from : parts.join("/");
  return anchor === undefined || anchor === "" ? { type: "file", path } : { type: "file", path, anchor };
}

const Evidence = z.strictObject({
  path: z.string(),
  line: z.number().int().positive(),
  quote: z.string().min(1),
});

export const ClaimSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  /** The document that states the claim. */
  source: z.string(),
  statement: z.string().min(1),
  status: z.enum(["verified", "drift", "no-evidence"]),
  evidence: Evidence.optional(),
});
export type Claim = z.output<typeof ClaimSchema>;

/** Claims a docs analysis checked against the code (`docs/metator/claims.json`). */
export const ClaimSetSchema = z.strictObject({ claims: z.array(ClaimSchema) }).superRefine((set, ctx) => {
  const seen = new Set<string>();
  set.claims.forEach((c, i) => {
    if (seen.has(c.id))
      ctx.addIssue({ code: "custom", path: ["claims", i, "id"], message: `Duplicate claim "${c.id}"` });
    seen.add(c.id);
    if (c.status === "verified" && !c.evidence)
      ctx.addIssue({
        code: "custom",
        path: ["claims", i, "evidence"],
        message: `Claim "${c.id}" is verified without evidence`,
      });
  });
});
export type ClaimSet = z.output<typeof ClaimSetSchema>;

export const ClaimSetDocument = defineDocument("ClaimSet", {
  latest: ClaimSetSchema,
  hint: "Claims are written by the docs analysis (W7); a verified claim needs evidence {path, line, quote}.",
});
