import { z } from "zod";
import { MetatorError } from "./errors.ts";
import { err, ok, type Result } from "./result.ts";
import { defineDocument, readFrontMatter, renderFrontMatter } from "./versioned.ts";

/**
 * Module card (ADR-0022): one Markdown file per workspace package. The block between the
 * `metator:generated` markers is derived from the index and rewritten by `cards build`;
 * everything else is curated by people and never touched.
 */
export const ModuleCardDocument = defineDocument("ModuleCard", {
  latest: z.object({
    package: z.string().min(1),
    dir: z.string().min(1),
  }),
});

export const GENERATED_START = "<!-- metator:generated:start -->";
export const GENERATED_END = "<!-- metator:generated:end -->";

export interface CardParts {
  readonly package: string;
  readonly dir: string;
  /** Curated Markdown before the generated block (usually the `# package` title). */
  readonly before: string;
  readonly generated: string;
  /** Curated Markdown after the generated block. */
  readonly after: string;
}

/** Splits a card into header, curated parts and the generated block; never guesses. */
export function splitCard(text: string, source: string): Result<CardParts, MetatorError> {
  const header = readFrontMatter(text, source).andThen((raw) => ModuleCardDocument.parse(raw, source));
  if (header.isErr()) return err(header.error);
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const start = body.indexOf(GENERATED_START);
  const end = body.indexOf(GENERATED_END);
  if (start < 0 || end < start || body.indexOf(GENERATED_START, start + 1) >= 0) {
    return err(
      new MetatorError("INVALID_ARTIFACT", `${source}: expected exactly one generated block`, {
        hint: `Keep one ${GENERATED_START} … ${GENERATED_END} block; \`metator cards build\` rewrites only its content.`,
      }),
    );
  }
  return ok({
    package: header.value.package,
    dir: header.value.dir,
    before: body.slice(0, start),
    generated: body.slice(start + GENERATED_START.length, end),
    after: body.slice(end + GENERATED_END.length),
  });
}

export function renderCard(parts: CardParts): string {
  const header = ModuleCardDocument.stamp({ package: parts.package, dir: parts.dir });
  return renderFrontMatter(
    header,
    `${parts.before}${GENERATED_START}${parts.generated}${GENERATED_END}${parts.after}`,
  );
}

/** Curated sections a new card starts with (template: docs/design/05-templates.md §7). */
export function cardSkeleton(pkg: string): { before: string; after: string } {
  return {
    before: `\n# ${pkg}\n\n`,
    after: [
      "",
      "",
      "## Responsibility",
      "",
      "TODO: what this package does, and what it deliberately does not do.",
      "",
      "## Invariants",
      "",
      'TODO: rules the code must keep, each with a citation like `[[cite: path/to/file.ts:1 | "exact code"]]`.',
      "",
      "## Allowed dependencies",
      "",
      "TODO: which packages it may depend on, and which it must not.",
      "",
      "## Pitfalls",
      "",
      "TODO: what usually goes wrong here.",
      "",
    ].join("\n"),
  };
}
