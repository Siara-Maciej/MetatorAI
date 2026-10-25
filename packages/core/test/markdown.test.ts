import { describe, expect, test } from "bun:test";
import { markdownAnchors } from "../src/domain/markdown.ts";

describe("markdownAnchors", () => {
  test("GitHub slugs: lower case, punctuation dropped, duplicates numbered, code spans unwrapped", () => {
    const md = [
      "# MetatorAI",
      "## Every file is a versioned document (ADR-0016)",
      "## Dependency policy: don't reinvent the wheel",
      "### `rules pack`",
      "## Setup",
      "## Setup",
      "#### Closing hashes ##",
    ].join("\n");
    expect([...markdownAnchors(md)]).toEqual([
      "metatorai",
      "every-file-is-a-versioned-document-adr-0016",
      "dependency-policy-dont-reinvent-the-wheel",
      "rules-pack",
      "setup",
      "setup-1",
      "closing-hashes",
    ]);
  });

  test("headings inside fenced code blocks are not anchors; #hashtags are not headings", () => {
    const md = "```bash\n# a comment\n```\n~~~\n## also code\n~~~\n#hashtag\n## Real";
    expect([...markdownAnchors(md)]).toEqual(["real"]);
  });
});
