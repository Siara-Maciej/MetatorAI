import { describe, expect, test } from "bun:test";
import { MetatorConfigDocument } from "../src/domain/config.ts";
import { commandsOf } from "../src/domain/discovery.ts";
import {
  claudeDenyRules,
  commitReach,
  consentsIn,
  DEFAULT_GUARD_COMMANDS,
  DEFAULT_GUARD_CONFIG,
  deniedPrefixes,
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
      "[metator] The task 20261121-x is done. Commit it",
      "metator: commit",
      "commit this?",
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

describe("one deny list for both hosts (ADR-0100): the same never patterns, each host's syntax", () => {
  test("a pattern is its words, open when it ends in *", () => {
    expect(deniedPrefixes(["git push --force*", "git reset --hard", "rm -r /*"])).toEqual([
      { words: "git push --force", open: true },
      { words: "git reset --hard", open: false },
      { words: "rm -r /", open: true },
    ]);
  });

  test("Claude Code and Copilot CLI are given the same commands, in prompt mode the pushes too", () => {
    for (const headless of [false, true]) {
      const copilot = denyToolsOf(DEFAULT_GUARD_COMMANDS, { headless }).map((t) => t.slice(6, -1));
      const claude = claudeDenyRules(DEFAULT_GUARD_COMMANDS, { headless }).map((r) =>
        r.slice(5, -1).replace(/ \*$|\*$/, ""),
      );
      expect(new Set(claude)).toEqual(new Set(copilot));
    }
    const claude = claudeDenyRules(DEFAULT_GUARD_COMMANDS, { headless: false });
    // An open pattern also stops `--force-with-lease`; a closed one is the command with and without arguments.
    expect(claude).toContain("Bash(git push --force*)");
    expect(claude).toEqual(expect.arrayContaining(["Bash(git reset --hard)", "Bash(git reset --hard *)"]));
    // A merge asks (ADR-0094): it is never a deny rule, on either host.
    expect(
      [...claude, ...denyToolsOf(DEFAULT_GUARD_COMMANDS, { headless: true })].some((r) =>
        r.includes("merge"),
      ),
    ).toBe(false);
    expect(claudeDenyRules(DEFAULT_GUARD_COMMANDS, { headless: true })).toContain("Bash(git push *)");
  });
});

describe("commitReach: what a `git commit` in a command line would take, beyond what is staged now", () => {
  const ROOT = "/repo";
  const reach = (line: string, cwd = ROOT) => commitReach(commandsOf(line), { root: ROOT, cwd });
  const NONE = { tracked: false, untracked: false, paths: [] };

  test("no commit in the line reaches nothing; a plain commit takes only what is staged", () => {
    expect(reach("git add src/server.ts")).toBeUndefined();
    expect(reach("git status && git diff")).toBeUndefined();
    expect(reach('git commit -m "Log the sku"')).toEqual(NONE);
    expect(reach("git commit --amend --no-edit")).toEqual(NONE);
    // The message and other values are no paths.
    expect(reach('git commit -m "fix src/a.ts" --author "Ana <a@x>" -F notes.txt --date now')).toEqual(NONE);
  });

  test("the real bypass: `git add <path> && git commit` in one call takes that path", () => {
    expect(reach('git add src/server.ts && git commit -m "Log the sku in the GET /prices handler"')).toEqual({
      tracked: false,
      untracked: false,
      paths: ["src/server.ts"],
    });
    expect(reach("git add src/a.ts src/b.ts; git commit -m x")?.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(reach("git stage src/a.ts && git commit -m x")?.paths).toEqual(["src/a.ts"]);
    // An add after the commit is not in it.
    expect(reach("git commit -m x && git add src/a.ts")).toEqual(NONE);
  });

  test("add -A, add ., add -u, commit -a: every changed file, new ones too for -A and .", () => {
    const all = { tracked: true, untracked: true, paths: [] };
    expect(reach("git add -A && git commit -m x")).toEqual(all);
    expect(reach("git add --all; git commit -m x")).toEqual(all);
    expect(reach("git add . && git commit -m x")).toEqual(all);
    expect(reach("git add -u && git commit -m x")).toEqual({ tracked: true, untracked: false, paths: [] });
    for (const line of ["git commit -a -m x", "git commit -am x", "git commit --all", "git commit -qam x"])
      expect(reach(line)).toEqual({ tracked: true, untracked: false, paths: [] });
  });

  test("paths named on the commit itself, and where the shell stands: cd, git -C, a subdirectory", () => {
    expect(reach("git commit -m x -- src/a.ts")?.paths).toEqual(["src/a.ts"]);
    expect(reach("git commit src/a.ts -m x")?.paths).toEqual(["src/a.ts"]);
    expect(reach("git commit --only src/a.ts -m x")?.paths).toEqual(["src/a.ts"]);
    expect(reach("cd src && git add server.ts && git commit -m x")?.paths).toEqual(["src/server.ts"]);
    expect(reach("cd src; git add . ; git commit -m x")).toEqual({
      tracked: false,
      untracked: false,
      paths: ["src"],
    });
    expect(reach("git -C packages/shop add src/price.ts && git -C packages/shop commit -m x")?.paths).toEqual(
      ["packages/shop/src/price.ts"],
    );
    expect(reach("git add ../lib/a.ts && git commit -m x", "/repo/src")?.paths).toEqual(["lib/a.ts"]);
    expect(reach("git add /repo/src/a.ts && git commit -m x")?.paths).toEqual(["src/a.ts"]);
    // Outside the repository: not this repository's commit to judge.
    expect(reach("git add /elsewhere/a.ts && git commit -m x")?.paths).toEqual([]);
    // A glob stays a pattern.
    expect(reach("git add src/*.ts && git commit -m x")?.paths).toEqual(["src/*.ts"]);
  });
});

describe("guard.prompts (MetatorConfig v14): who answers for what is safe", () => {
  test("the default is MetatorAI; `host` keeps the host's own prompts; a v13 file reads as the default", () => {
    expect(DEFAULT_GUARD_CONFIG.prompts).toBe("metator");
    const v13 = MetatorConfigDocument.parse(
      { kind: "MetatorConfig", schemaVersion: 13, guard: { commands: { never: ["npm publish"] } } },
      "c",
    )._unsafeUnwrap();
    expect([v13.guard.prompts, v13.guard.commands.never]).toEqual(["metator", ["npm publish"]]);
    const host = MetatorConfigDocument.parse(
      { kind: "MetatorConfig", schemaVersion: 14, guard: { prompts: "host" } },
      "c",
    )._unsafeUnwrap();
    expect(host.guard.prompts).toBe("host");
    // The field is v14's: a v13 file that sets it is refused with its name.
    const early = MetatorConfigDocument.parse(
      { kind: "MetatorConfig", schemaVersion: 13, guard: { prompts: "host" } },
      "c",
    )._unsafeUnwrapErr();
    expect([early.code, early.message.includes("prompts")]).toEqual(["INVALID_CONFIG", true]);
    expect(
      MetatorConfigDocument.parse(
        { kind: "MetatorConfig", schemaVersion: 14, guard: { prompts: "never" } },
        "c",
      ).isErr(),
    ).toBe(true);
  });
});
