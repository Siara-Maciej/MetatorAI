import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import { FindOwners } from "../src/application/owners.ts";
import { codeownersGlobs, ownersOf, parseCodeowners } from "../src/domain/owners.ts";

// GitHub's documented examples (docs: "About code owners", example CODEOWNERS file).
const CODEOWNERS = `# This is a comment.
*       @global-owner1 @global-owner2
*.js    @js-owner #This is an inline comment.
*.go docs@example.com
/build/logs/ @doctocat
docs/*  docs@example.com
apps/ @octocat
/docs/ @doctocat
/scripts/ @doctocat @octocat
/apps/github
[Backend]
**/logs @octocat
`;
const rules = parseCodeowners(CODEOWNERS);
const owners = (path: string) => ownersOf(path, rules).owners;

describe("parseCodeowners", () => {
  test("rules with their line; comments, blank lines and section headers are skipped", () => {
    expect(rules.map((r) => [r.pattern, r.owners.length, r.line])).toEqual([
      ["*", 2, 2],
      ["*.js", 1, 3],
      ["*.go", 1, 4],
      ["/build/logs/", 1, 5],
      ["docs/*", 1, 6],
      ["apps/", 1, 7],
      ["/docs/", 1, 8],
      ["/scripts/", 2, 9],
      ["/apps/github", 0, 10],
      ["**/logs", 1, 12],
    ]);
  });
});

describe("codeownersGlobs", () => {
  test("anchored, unanchored, directory and one-level patterns", () => {
    expect(codeownersGlobs("*.js")).toEqual(["**/*.js", "**/*.js/**"]);
    expect(codeownersGlobs("/build/logs/")).toEqual(["build/logs/**"]);
    expect(codeownersGlobs("apps/")).toEqual(["**/apps/**"]);
    expect(codeownersGlobs("docs/*")).toEqual(["docs/*"]);
    expect(codeownersGlobs("/apps/github")).toEqual(["apps/github", "apps/github/**"]);
  });
});

describe("ownersOf", () => {
  test("the last matching line wins, as GitHub documents it", () => {
    expect(owners("README.md")).toEqual(["@global-owner1", "@global-owner2"]);
    expect(owners("src/app.js")).toEqual(["@js-owner"]);
    // /build/logs/ matches, but the later **/logs line matches too and wins.
    expect(owners("build/logs/x/out.txt")).toEqual(["@octocat"]);
    expect(ownersOf("build/logs/x/out.txt", rules.slice(0, 4)).owners).toEqual(["@doctocat"]);
    expect(owners("web/apps/main.ts")).toEqual(["@octocat"]);
    expect(owners("scripts/release.sh")).toEqual(["@doctocat", "@octocat"]);
    expect(owners("a/b/logs/today.txt")).toEqual(["@octocat"]);
  });

  test("docs/* owns files directly in docs/ only; /docs/ owns everything below", () => {
    const one = parseCodeowners("docs/* @a\n");
    expect(ownersOf("docs/intro.md", one).owners).toEqual(["@a"]);
    expect(ownersOf("docs/build/x.md", one).owners).toEqual([]);
    expect(owners("docs/build/x.md")).toEqual(["@doctocat"]);
  });

  test("a line without owners leaves the path unowned; no matching line names no rule", () => {
    expect(ownersOf("apps/github/x.ts", rules)).toEqual({
      path: "apps/github/x.ts",
      owners: [],
      rule: { pattern: "/apps/github", line: 10 },
    });
    expect(ownersOf("x.ts", parseCodeowners("*.md @a"))).toEqual({ path: "x.ts", owners: [] });
  });
});

describe("FindOwners", () => {
  test("reads the first CODEOWNERS GitHub would use", async () => {
    const fs = new InMemoryFileSystem({ ".github/CODEOWNERS": "* @gh", CODEOWNERS: "* @root" });
    expect((await new FindOwners(fs).execute({ paths: ["a.ts"] }))._unsafeUnwrap()).toEqual({
      source: ".github/CODEOWNERS",
      owners: [{ path: "a.ts", owners: ["@gh"], rule: { pattern: "*", line: 1 } }],
    });
    const docsOnly = new InMemoryFileSystem({ "docs/CODEOWNERS": "* @docs" });
    expect((await new FindOwners(docsOnly).execute({ paths: ["a.ts"] }))._unsafeUnwrap().source).toBe(
      "docs/CODEOWNERS",
    );
  });

  test("no CODEOWNERS: every path is unowned and no source is named", async () => {
    expect(
      (await new FindOwners(new InMemoryFileSystem({})).execute({ paths: ["a.ts"] }))._unsafeUnwrap(),
    ).toEqual({
      owners: [{ path: "a.ts", owners: [] }],
    });
  });
});
