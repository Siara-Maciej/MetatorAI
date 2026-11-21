import { describe, expect, test } from "bun:test";
import { commandText } from "../src/model.ts";
import {
  askWhy,
  chatAgentOf,
  consentOf,
  dropText,
  OPEN_DIFF,
  opensDiff,
  scratchCount,
  scratchItems,
  scratchLine,
  scratchRepos,
} from "../src/stage1.ts";

describe("the chat's agent (round 13)", () => {
  test("the repository's conversation agent when the daemon names one, else the agent of before", () => {
    expect(chatAgentOf({ chatAgent: "mt-chat" })).toBe("mt-chat");
    expect(chatAgentOf({ hosts: ["claude"] })).toBe("mt-orchestrator");
    expect(chatAgentOf({ chatAgent: " " })).toBe("mt-orchestrator");
    expect(chatAgentOf(undefined)).toBe("mt-orchestrator");
  });
});

describe("the quick change's card (round 13)", () => {
  test("Open diff is no answer: only that choice alone opens the change", () => {
    expect(opensDiff([OPEN_DIFF])).toBe(true);
    expect(opensDiff(["Fine"])).toBe(false);
    expect(opensDiff([])).toBe(false);
    expect(opensDiff([OPEN_DIFF, "Fine"])).toBe(false);
  });
});

describe("a commit or push that needs the person's consent (round 13)", () => {
  // The host's approval of a guarded command, as the daemon reads it from Claude Code's screen.
  const fixture = {
    prompt: 'git commit -m "Add the list of supported currencies" — This command requires approval',
    command: 'git commit -m "Add the list of supported currencies"',
  };
  test("the card's heading is the command, and it says the command needs consent", () => {
    expect(commandText(fixture).short).toBe('git commit -m "Add the list of supported currencies"');
    const c = consentOf(fixture);
    expect(c?.kind).toBe("commit");
    expect(c?.text).toBe(
      "git commit needs your consent: it runs only when you say Yes here, or ask for it in the chat. MetatorAI never does it by itself.",
    );
  });
  test("push, merge and rebase too, after a cd or with git's own options; from the prompt without a command", () => {
    expect(consentOf({ prompt: "x", command: "cd packages/core && git push origin main" })?.kind).toBe(
      "push",
    );
    expect(consentOf({ prompt: "x", command: "git -C ../shop-web merge feature" })?.kind).toBe("merge");
    expect(consentOf({ prompt: "git rebase main — This command requires approval" })?.kind).toBe("rebase");
  });
  test("the guard's own reason is shown under the command; the host's plain line is not", () => {
    expect(askWhy(fixture)).toBeUndefined();
    expect(
      askWhy({
        command: "git commit -am 'Add VAT'",
        prompt:
          "git commit -am 'Add VAT' — this commit holds debug changes: src/price.ts. Remove them first (`metator scratch drop`), or answer here to commit anyway.",
      }),
    ).toBe(
      "this commit holds debug changes: src/price.ts. Remove them first (`metator scratch drop`), or answer here to commit anyway.",
    );
    // Without a command the prompt is the heading already.
    expect(askWhy({ prompt: "git push — something" })).toBeUndefined();
  });
  test("any other command is a plain permission prompt", () => {
    expect(consentOf({ prompt: "x", command: "git status" })).toBeUndefined();
    expect(consentOf({ prompt: "x", command: "bun test" })).toBeUndefined();
    // Not a word that only holds the verb, nor another program's argument.
    expect(consentOf({ prompt: "x", command: "git commit-tree abc" })).toBeUndefined();
    expect(consentOf({ prompt: "x", command: "echo legit commit" })).toBeUndefined();
    expect(consentOf({ prompt: "x", command: "grep -r push src" })).toBeUndefined();
  });
});

describe("debug changes (round 13)", () => {
  test("the count comes with the daemon's state: its own, or the named repositories' in a folder", () => {
    expect(scratchCount({ runs: [], scratch: 2 })).toBe(2);
    expect(scratchCount({ runs: [] })).toBe(0);
    expect(scratchCount(undefined)).toBe(0);
    const folder = {
      repos: [{ name: "billing", scratch: 1 }, { name: "shop-api", scratch: 3 }, { name: "shop-web" }],
    };
    expect(scratchCount(folder)).toBe(4);
    expect(scratchCount(folder, ["shop-api", "shop-web"])).toBe(3);
    expect(scratchRepos(folder)).toEqual(["billing", "shop-api"]);
    expect(scratchRepos(folder, ["shop-web"])).toEqual([]);
    // One repository: the daemon's own, asked for with no name; none when it counts nothing.
    expect(scratchRepos({ runs: [], scratch: 1 })).toEqual([undefined]);
    expect(scratchRepos({ runs: [] })).toEqual([]);
  });

  test("the list's items: files or one file, a note, when; anything else is left out", () => {
    const items = scratchItems(
      {
        items: [
          {
            id: "s1",
            files: ["src/a.ts", "src/b.ts"],
            note: "why the total is off",
            at: "2026-11-21T10:00:00.000Z",
          },
          { id: "s2", file: "src/c.ts", at: "2026-11-21T10:05:00.000Z" },
          { files: ["no id"] },
          "nonsense",
        ],
      },
      "shop-api",
    );
    expect(items.map((i) => [i.id, i.repo, i.files, i.note])).toEqual([
      ["s1", "shop-api", ["src/a.ts", "src/b.ts"], "why the total is off"],
      ["s2", "shop-api", ["src/c.ts"], undefined],
    ]);
    expect(scratchItems({})).toEqual([]);
    expect(scratchItems(undefined)).toEqual([]);
    expect(scratchLine(items[0] as never)).toBe("src/a.ts, src/b.ts · why the total is off");
    expect(scratchLine({ id: "x", files: ["a", "b", "c", "d", "e"], at: "" })).toBe("a, b, c and 2 more");
    expect(scratchLine({ id: "x", files: [], at: "" })).toBe("no file");
  });

  test("what removing them did: what was removed, and what could not be and why", () => {
    expect(
      dropText([
        {
          dropped: [
            { id: "s1", files: ["src/a.ts"] },
            { id: "s2", files: ["src/a.ts", "src/c.ts"] },
          ],
        },
      ]),
    ).toEqual({
      text: "Removed 2 debug changes (src/a.ts, src/c.ts).",
      ok: true,
    });
    expect(
      dropText([
        { dropped: [{ id: "s1", files: ["src/a.ts"] }] },
        { failed: [{ id: "s2", files: ["src/c.ts"], why: "the patch no longer applies" }] },
      ]),
    ).toEqual({
      text: "Removed 1 debug change (src/a.ts). 1 debug change could not be removed: src/c.ts (the patch no longer applies). Nothing was forced: undo it by hand.",
      ok: false,
    });
    expect(dropText([{ failed: [{ id: "s9", why: "the patch no longer applies" }] }]).text).toBe(
      "Nothing was removed. 1 debug change could not be removed: s9 (the patch no longer applies). Nothing was forced: undo it by hand.",
    );
    expect(dropText([{}])).toEqual({ text: "Nothing was removed.", ok: true });
  });
});
