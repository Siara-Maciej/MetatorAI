import { describe, expect, test } from "bun:test";
import { commandText } from "../src/shared/model/format.ts";
import {
  askWhy,
  changedWhy,
  consentOf,
  dropText,
  forgetText,
  goneText,
  OPEN_DIFF,
  opensDiff,
  scratchCount,
  scratchGone,
  scratchItems,
  scratchLine,
  scratchRepos,
} from "../src/shared/model/stage1.ts";

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

  // The daemon's own words for a record whose lines changed since (shapes.md, "Scratch REVISED").
  const WHY =
    "src/c.ts changed since it was recorded: its debug lines can no longer be taken out as they were. Take them out by hand, or forget the record (`metator scratch forget --id s2`)";

  test("the list's items: files, a note, when, and whether it can still be removed; anything else is left out", () => {
    const items = scratchItems(
      {
        items: [
          {
            id: "s1",
            files: ["src/a.ts", "src/b.ts"],
            note: "why the total is off",
            at: "2026-11-21T10:00:00.000Z",
            state: "removable",
          },
          { id: "s2", file: "src/c.ts", at: "2026-11-21T10:05:00.000Z", state: "changed", why: WHY },
          { files: ["no id"] },
          "nonsense",
        ],
      },
      "shop-api",
    );
    expect(items.map((i) => [i.id, i.repo, i.files, i.note, i.state])).toEqual([
      ["s1", "shop-api", ["src/a.ts", "src/b.ts"], "why the total is off", "removable"],
      ["s2", "shop-api", ["src/c.ts"], undefined, "changed"],
    ]);
    // A daemon that names no state: removable, as before.
    expect(scratchItems({ items: [{ id: "s1", files: ["a"] }] })[0]?.state).toBe("removable");
    expect(scratchItems({})).toEqual([]);
    expect(scratchItems(undefined)).toEqual([]);
    expect(scratchLine(items[0] as never)).toBe("src/a.ts, src/b.ts · why the total is off");
    expect(scratchLine({ id: "x", files: ["a", "b", "c", "d", "e"], at: "", state: "removable" })).toBe(
      "a, b, c and 2 more",
    );
    expect(scratchLine({ id: "x", files: [], at: "", state: "removable" })).toBe("no file");
    // Why a changed one cannot be removed: the daemon's first sentence, without its hint for a terminal.
    expect(changedWhy(items[1]?.why)).toBe(
      "src/c.ts changed since it was recorded: its debug lines can no longer be taken out as they were",
    );
    expect(changedWhy(undefined)).toBe("its lines changed since it was recorded");
  });

  test("a record that is gone is said, by the list and by a removal: nothing leaves silently", () => {
    const answer = {
      items: [],
      gone: [{ id: "s002", files: ["src/tax.ts"], why: "s002 is gone: src/tax.ts no longer holds it" }],
    };
    expect(scratchGone(answer)).toEqual(answer.gone);
    expect(goneText(scratchGone(answer))).toBe("s002 is gone: src/tax.ts no longer holds it.");
    expect(scratchGone({ items: [] })).toEqual([]);
    expect(scratchGone({ gone: [{ id: "s9" }, "x"] })).toEqual([{ id: "s9", files: [], why: "s9 is gone" }]);
    // A removal that found the record gone says that, not "nothing was removed".
    expect(dropText([{ dropped: [], failed: [], gone: answer.gone }])).toEqual({
      text: "s002 is gone: src/tax.ts no longer holds it.",
      ok: true,
    });
    expect(
      dropText([{ dropped: [{ id: "s001", files: ["debug.log"] }], failed: [], gone: answer.gone }]).text,
    ).toBe("Removed 1 debug change (debug.log). s002 is gone: src/tax.ts no longer holds it.");
  });

  test("what removing them did: what was removed, and what could not be, why, and that it stays", () => {
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
        { failed: [{ id: "s2", files: ["src/c.ts"], why: WHY }] },
      ]),
    ).toEqual({
      text: "Removed 1 debug change (src/a.ts). 1 debug change could not be removed: src/c.ts changed since it was recorded: its debug lines can no longer be taken out as they were. Nothing was forced: it stays in the list; take its lines out by hand, or forget it.",
      ok: false,
    });
    expect(
      dropText([
        {
          failed: [
            { id: "s2", why: WHY },
            { id: "s3", why: "src/d.ts changed since it was recorded: x. Take them out by hand" },
          ],
        },
      ]).text,
    ).toBe(
      "Nothing was removed. 2 debug changes could not be removed: src/c.ts changed since it was recorded: its debug lines can no longer be taken out as they were; src/d.ts changed since it was recorded: x. Nothing was forced: they stay in the list; take their lines out by hand, or forget them.",
    );
    expect(dropText([{}])).toEqual({ text: "Nothing was removed.", ok: true });
  });

  test("forgetting a record touches no file, and says so", () => {
    expect(forgetText({ forgotten: [{ id: "s2", files: ["src/c.ts"] }] })).toBe(
      "Forgot 1 debug change (src/c.ts): its lines stay in your files.",
    );
    expect(
      forgetText({
        forgotten: [
          { id: "s2", files: ["a"] },
          { id: "s3", files: ["b"] },
        ],
      }),
    ).toBe("Forgot 2 debug changes (a, b): their lines stay in your files.");
    expect(forgetText({})).toBe("Nothing was forgotten.");
  });
});
