import { describe, expect, test } from "bun:test";
import {
  consentsIn,
  DEFAULT_GUARD_COMMANDS,
  denyToolsOf,
  type GuardCommands,
  guardCommand,
  matchesCommand,
} from "../src/domain/guard-commands.ts";

const argv = (command: string) => command.split(" ");
const level = (command: string, commands: GuardCommands = DEFAULT_GUARD_COMMANDS) =>
  guardCommand(argv(command), commands).level;

describe("matchesCommand: a pattern's program, git subcommand and flags against a command", () => {
  test("the program by its name, git's subcommand after its global options, a word anywhere for others", () => {
    expect(matchesCommand("git push", argv("git push origin main"))).toBe(true);
    expect(matchesCommand("git push", argv("/usr/bin/git -C ../shop -c a=b push"))).toBe(true);
    // The subcommand, not a word of a message or another subcommand's argument.
    expect(matchesCommand("git push", argv("git commit -m push"))).toBe(false);
    expect(matchesCommand("git push", argv("git stash push"))).toBe(false);
    expect(matchesCommand("git commit", argv("gitk commit"))).toBe(false);
    expect(matchesCommand("gh pr merge", argv("gh pr merge 7 --squash"))).toBe(true);
    expect(matchesCommand("gh pr merge", argv("gh pr view 7"))).toBe(false);
  });

  test("flags: a long one by glob (also before =), a short one inside a cluster", () => {
    expect(matchesCommand("git push --force*", argv("git push --force-with-lease=main origin"))).toBe(true);
    expect(matchesCommand("git push --force*", argv("git push origin main"))).toBe(false);
    expect(matchesCommand("git push -f", argv("git push -uf origin main"))).toBe(true);
    expect(matchesCommand("git clean -f", argv("git clean -xdf"))).toBe(true);
    expect(matchesCommand("git clean -f", argv("git clean -n"))).toBe(false);
    expect(matchesCommand("git reset --hard", argv("git reset --hard HEAD~1"))).toBe(true);
    expect(matchesCommand("rm -r .git", argv("rm -rf build .git"))).toBe(true);
    expect(matchesCommand("rm -r /", argv("rm -rf dist"))).toBe(false);
  });
});

describe("guardCommand: never, ask (with its kind), allow", () => {
  test("the defaults: force pushes, hard resets, cleans, history rewriting and deleting the repository never run", () => {
    for (const c of [
      "git push --force origin main",
      "git push -f",
      "git push --force-with-lease",
      "git reset --hard HEAD~1",
      "git clean -fdx",
      "git rebase -i HEAD~3",
      "git rebase --interactive main",
      "git filter-branch --tree-filter x HEAD",
      "git filter-repo --path src",
      "rm -rf /",
      "rm -rf .git",
      "rm -r .",
    ])
      expect([c, level(c)]).toEqual([c, "never"]);
  });

  test("the defaults: commit, push, merge and rebase ask, each as its own kind; the rest is allowed", () => {
    expect(guardCommand(argv("git commit -m x"), DEFAULT_GUARD_COMMANDS)).toEqual({
      level: "ask",
      pattern: "git commit",
      kind: "commit",
    });
    expect(guardCommand(argv("git push -u origin feature"), DEFAULT_GUARD_COMMANDS).kind).toBe("push");
    expect(guardCommand(argv("git merge main"), DEFAULT_GUARD_COMMANDS).kind).toBe("merge");
    expect(guardCommand(argv("git rebase main"), DEFAULT_GUARD_COMMANDS).kind).toBe("rebase");
    for (const c of [
      "git status",
      "git add -A",
      "git reset --soft HEAD~1",
      "rm -rf dist",
      "git clean -n",
      "ls",
    ])
      expect([c, level(c)]).toEqual([c, "allow"]);
  });

  test("never wins over allow; allow lifts an ask; a repository's own list replaces the defaults", () => {
    const own: GuardCommands = {
      never: ["git push --force*", "npm publish"],
      ask: ["git commit", "git tag"],
      allow: ["git commit --dry-run", "git push --force*"],
    };
    expect(level("git commit --dry-run", own)).toBe("allow");
    expect(level("git commit -m x", own)).toBe("ask");
    expect(level("git push --force", own)).toBe("never");
    expect(level("npm publish", own)).toBe("never");
    expect(guardCommand(argv("git tag v1"), own).kind).toBe("tag");
    // What the repository no longer lists is allowed.
    expect(level("git push origin main", own)).toBe("allow");
  });
});

describe("consentsIn: the person's own words that consent to a guarded command", () => {
  const kinds = ["commit", "push", "merge", "rebase"];
  test("plain words in English and Polish, one kind each; several in one sentence", () => {
    expect(consentsIn("commit it", kinds)).toEqual(["commit"]);
    expect(consentsIn("ok, zacommituj to", kinds)).toEqual(["commit"]);
    expect(consentsIn("Zrób commit i wypchnij", kinds)).toEqual(["commit", "push"]);
    expect(consentsIn("please commit and push", kinds)).toEqual(["commit", "push"]);
    expect(consentsIn("zmerguj to z main", kinds)).toEqual(["merge"]);
    expect(consentsIn("rebase onto main", kinds)).toEqual(["rebase"]);
  });

  test("a refusal, a question, an agent's line and unrelated words consent to nothing", () => {
    for (const words of [
      "do not commit yet",
      "don't push",
      "nie commituj tego",
      "nie wypychaj",
      "no push yet",
      "should we commit this?",
      "czy mam to wypchnąć?",
      "[metator] From the person, through the main chat: commit it",
      "metator: no output for a while and no question is open. Go on with the next step of your plan",
      "add a console.log to the commit handler module",
      "explain what the committee decided",
    ])
      expect([words, consentsIn(words, kinds)]).toEqual([words, []]);
    // Only the kinds the config asks about.
    expect(consentsIn("commit and push", ["commit"])).toEqual(["commit"]);
  });
});

describe("denyToolsOf: Copilot's process-level list, from the same config", () => {
  test("every never pattern as a shell prefix; in prompt mode, pushes too (nobody can be asked there)", () => {
    const interactive = denyToolsOf(DEFAULT_GUARD_COMMANDS, { headless: false });
    expect(interactive).toContain("shell(git push --force)");
    expect(interactive).toContain("shell(git reset --hard)");
    expect(interactive).not.toContain("shell(git push)");
    expect(interactive).not.toContain("shell(git commit)");
    const headless = denyToolsOf(DEFAULT_GUARD_COMMANDS, { headless: true });
    expect(headless).toContain("shell(git push)");
    expect(headless).not.toContain("shell(git commit)");
    expect(denyToolsOf({ never: [], ask: [], allow: [] }, { headless: true })).toEqual([]);
  });
});
