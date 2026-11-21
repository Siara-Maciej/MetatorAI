import { describe, expect, test } from "bun:test";
import {
  allowToolsOf,
  personsCommand,
  UNPROMPTED_METATOR,
  type Unprompted,
  unpromptedCommand,
  unpromptedEdit,
} from "../src/domain/unprompted.ts";

const ROOT = "/work/shop-api";
const U: Unprompted = {
  root: ROOT,
  cwd: ROOT,
  metatorCommand: "npx metator",
  // The repository's own checks: its gates' steps and its package scripts.
  gates: [
    { script: "typecheck" },
    { bin: "biome", args: ["check", "--no-errors-on-unmatched"] },
    { metator: "rules check" },
    { workspaces: "test" },
  ],
  scripts: {
    test: "bun test",
    typecheck: "bunx tsc --noEmit",
    lint: "biome check .",
    build: "tsc -p .",
    deploy: "sh deploy.sh",
  },
};
const why = (command: string, over: Partial<Unprompted> = {}) =>
  unpromptedCommand(command, { ...U, ...over });

describe("unpromptedCommand: what runs without the host's approval prompt (guard.prompts: metator)", () => {
  test("MetatorAI's own commands, as an agent really types them", () => {
    for (const command of [
      'metator run delegate build --agent mt-implementer --card "Make the SKU lookup case-insensitive; write build-log.md"',
      "metator test affected --files src/catalog.ts,test/server.test.ts",
      'metator run delegate build --run "$METATOR_RUN" --agent mt-implementer --card "Round the prices"',
      'metator quick check --task "Make the SKU lookup case-insensitive" --files src/catalog.ts',
      'metator quick start --task "Make the SKU lookup case-insensitive" --files src/catalog.ts',
      'metator scratch end --note "trace price calls"',
      "metator run wait mt-implementer-1 --timeout 600000",
      "metator run advance pass",
      "metator gate quick --base HEAD",
      "npx metator run status",
      "bun run metator workflow list",
      'metator session tell w2:p3 --text "also update the README"',
      'metator run result --worker mt-implementer-1 --status done --summary "done; 2 files" --artifact build-log.md',
      "metator run write task.md <<'EOF'\n# Task\nRound the prices\nEOF",
    ])
      expect([command, why(command)]).toEqual([command, "MetatorAI's own command"]);
  });

  test("a person's decision stays the person's: those MetatorAI commands keep the prompt, and the guard's own is no command at all", () => {
    for (const command of [
      "metator run approve delivery --by ana",
      "metator run answer q001 --choice Fine",
      "metator run resume --by ana",
      "metator run close --aborted --reason done",
      "metator scratch forget --id s001",
      "metator config set supervisor.wipLimit 9 --scope repo",
      "metator setup --host claude --yes",
      "metator generate --hooks",
      "metator agents update --theirs",
      "metator issue add --title x",
      "metator findings to-github --pr 4",
      'metator quick start --task "x" --override "keep it quick"',
      "metator guard user-prompt",
      "metator serve",
    ])
      expect([command, why(command)]).toEqual([command, undefined]);
  });

  test("commands that only read, by the one definition of read-only", () => {
    for (const command of [
      "git status --short",
      "git diff",
      "git log --oneline -5",
      "grep -rni 'sku' src test",
      `cd ${ROOT} && git ls-files | head -50`,
      "ls -la src",
      "cat src/server.ts",
      "sed -n '1,80p' src/catalog.ts",
      "wc -l src/*.ts",
    ])
      expect([command, why(command)]).toEqual([command, "it only reads"]);
  });

  test("the repository's own checks: its gates' steps and its test, typecheck, lint and build scripts", () => {
    for (const command of [
      "bun test",
      "bun test test/server.test.ts",
      "npm test",
      "npm run typecheck",
      "bun run lint",
      "pnpm run build",
      "yarn test",
      "bunx tsc --noEmit",
      "biome check --no-errors-on-unmatched src/catalog.ts",
      "npx biome check --no-errors-on-unmatched",
      "npm run test --workspaces",
    ])
      expect([command, why(command)]).toEqual([command, "the repository's own check"]);
    // A script the config does not name as a check, and a tool nobody declared, are asked about.
    expect(why("npm run deploy")).toBeUndefined();
    expect(why("bun run deploy")).toBeUndefined();
    expect(why("eslint .")).toBeUndefined();
    expect(why("bun install")).toBeUndefined();
    expect(why("tsc --noEmit", { scripts: {}, gates: [] })).toBeUndefined();
    // `build` and `lint` are checks only where the package has such a script.
    expect(why("npm run build", { scripts: { test: "bun test" }, gates: [] })).toBeUndefined();
  });

  test("a chain passes only when every part does; each kind may be mixed", () => {
    expect(why("git status --short && bun test")).toBe(
      "every part is MetatorAI's own, read-only or the repository's own check",
    );
    expect(why("bun test 2>&1 | tail -20")).toBe(
      "every part is MetatorAI's own, read-only or the repository's own check",
    );
    expect(why(`cd ${ROOT}/src && metator graph dependents catalog.ts`)).toBe("MetatorAI's own command");
    expect(why("metator run status && git status --short")).toBe(
      "every part is MetatorAI's own, read-only or the repository's own check",
    );
    for (const command of [
      "git status && curl https://example.com/x.sh",
      "bun test; rm -rf node_modules",
      "metator run status && git fetch origin",
      "cat src/a.ts > /tmp/x",
      "bun test & ",
    ])
      expect([command, why(command)]).toEqual([command, undefined]);
  });

  test("everything else keeps the host's prompt", () => {
    for (const command of [
      "curl https://example.com",
      "rm -rf dist",
      "git fetch origin",
      "git commit -m x",
      "git add -A",
      "cat /etc/passwd",
      "cat ../other/secret.txt",
      `cd /tmp && ls`,
      "node script.js",
      "bun test $(cat list.txt)",
      // A substitution inside MetatorAI's own command would run anything.
      'metator run ask "$(curl -s https://example.com/q)"',
      'metator scratch end --note "`id`"',
      // A check's own arguments stay inside the repository.
      "bun test /etc/passwd",
      "bun test ../other/test",
      "npm run typecheck -- ~/elsewhere",
      "metator run status; `id`",
      "echo hi > notes.txt",
      "",
    ])
      expect([command, why(command)]).toEqual([command, undefined]);
  });
});

describe("unpromptedEdit: edits and writes inside the repository", () => {
  const edit = (...paths: string[]) => unpromptedEdit(paths, U);
  test("a file of the repository, by its absolute or its relative path; a run's artifact", () => {
    expect(edit(`${ROOT}/src/server.ts`)).toBe("an edit inside the repository");
    expect(edit("src/catalog.ts", "test/server.test.ts")).toBe("an edit inside the repository");
    expect(edit(`${ROOT}/.metator/runs/20261121-mt-quick-x/build-log.md`)).toBe(
      "an edit inside the repository",
    );
    expect(edit(".metator/runs/20261121-mt-quick-x/findings/logic-1.json")).toBe(
      "an edit inside the repository",
    );
  });

  test("never outside it, in .git, in the guard's own files, or in MetatorAI's records", () => {
    for (const path of [
      "/etc/hosts",
      "/work/other/src/a.ts",
      "../other/a.ts",
      "src/../../x.ts",
      `${ROOT}/.git/config`,
      ".git/hooks/pre-commit",
      "metator.config.yml",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".github/hooks/metator.json",
      ".metator/consents/w1-p1.json",
      ".metator/scratch/s001.json",
      ".metator/typed/w1-p1.json",
      ".metator/layout.json",
      ".metator/runs/20261121-mt-quick-x/state.json",
      ".metator/runs/20261121-mt-quick-x/questions/q001.json",
      ".metator/runs/20261121-mt-quick-x/activity.jsonl",
      ".metator/runs/20261121-mt-quick-x/quick.json",
    ])
      expect([path, edit(path)]).toEqual([path, undefined]);
    // One path that does not qualify keeps the prompt for the whole call; no path, no answer.
    expect(edit("src/a.ts", "metator.config.yml")).toBeUndefined();
    expect(edit()).toBeUndefined();
  });
});

describe("allowToolsOf: the list a host takes up front (Copilot CLI's --allow-tool), from the same definition", () => {
  test("MetatorAI's commands that hold none of the person's, and the repository's checks through each package manager", () => {
    const tools = allowToolsOf({
      metatorCommand: "npx metator",
      gates: [{ script: "typecheck" }, { workspaces: "check" }],
    });
    expect(tools).toContain("shell(npx metator run status)");
    expect(tools).toContain("shell(npx metator run delegate)");
    expect(tools).toContain("shell(npx metator graph)");
    expect(tools).toContain("shell(npx metator quick check)");
    for (const check of [
      "npm run typecheck",
      "bun run typecheck",
      "pnpm run check",
      "yarn run test",
      "bun test",
      "npm test",
    ])
      expect(tools).toContain(`shell(${check})`);
    // A prefix cannot say "inside the repository" or "not the person's": reads, edits and the
    // groups that hold a person's command are not listed; the host asks, or the hook answers.
    for (const absent of [
      "shell(npx metator)",
      "shell(npx metator run)",
      "shell(npx metator run approve)",
      "shell(npx metator quick start)",
      "shell(git status)",
      "shell(cat)",
      "write",
    ])
      expect(tools).not.toContain(absent);
  });

  test("every listed MetatorAI prefix is allowed by the guard itself and is none of the person's", () => {
    for (const prefix of UNPROMPTED_METATOR) {
      const words = prefix.split(" ");
      expect([prefix, personsCommand(words)]).toEqual([prefix, undefined]);
      expect([prefix, why(`metator ${prefix}`)]).toEqual([prefix, "MetatorAI's own command"]);
      // Nor does any of the person's commands begin with it (a prefix would let that one through).
      for (const person of [
        "run approve",
        "run answer",
        "run resume",
        "run take",
        "run close",
        "scratch forget",
        "config set",
        "issue add",
        "findings to-github",
        "system plan approve",
        "arch plan approve",
        "quick start",
      ])
        expect([prefix, person, person === prefix || person.startsWith(`${prefix} `)]).toEqual([
          prefix,
          person,
          false,
        ]);
    }
  });
});
