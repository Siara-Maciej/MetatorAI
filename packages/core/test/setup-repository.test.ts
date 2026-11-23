import { describe, expect, test } from "bun:test";
import { InMemoryFileSystem } from "@metator/testing";
import {
  type ConfiguredRepository,
  ignoreLocalState,
  SETUP_CHECKS,
  type SetupDependencies,
  SetupRepository,
} from "../src/application/setup-repository.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";

interface World {
  files?: Record<string, string>;
  source?: string;
  hosts?: ("claude" | "copilot")[];
  onPath?: ("claude" | "copilot")[];
  /** Lint errors of the agents, as `file: message` (a file the canon wrote is setup's own). */
  agentProblems?: string[];
  workflowProblems?: string[];
  stale?: string[];
  initFails?: boolean;
  /** The config file init says it wrote. */
  initWritten?: string;
  canonSteps?: { action: string; path: string }[];
  canonFails?: boolean;
  badConfig?: boolean;
}

function world(w: World = {}) {
  const fs = new InMemoryFileSystem(w.files ?? {});
  const calls: string[] = [];
  const canon = {
    execute: async (i: { mode: string; dryRun: boolean; workflows?: string[] }) => {
      calls.push(
        `canon ${i.mode}${i.dryRun ? " dry" : ""}${i.workflows ? ` [${i.workflows.join(",")}]` : ""}`,
      );
      if (w.canonFails && !i.dryRun) return err(new MetatorError("COMMAND_FAILED", "the canon is not here"));
      return ok({
        version: "1.2.3",
        from: "canon",
        available: ["mt-feature", "mt-tiny"],
        workflows: i.workflows ?? ["mt-feature", "mt-tiny"],
        steps: w.canonSteps ?? [
          { action: "add", path: "metator/agents/a.md" },
          { action: "add", path: "metator/agents/b.md" },
          { action: "conflict", path: "metator/agents/c.md" },
        ],
        removedUpstream: ["metator/agents/old.md"],
        lock: i.dryRun ? null : "metator/install.lock.json",
      });
    },
  };
  const generated = (kind: string) => ({
    execute: async (i: { check: boolean; hooks?: boolean }) => {
      calls.push(`${kind}${i.check ? " check" : ""}${i.hooks ? " hooks" : ""}`);
      return ok({
        written: i.check ? [] : [`${kind}/x`, `${kind}/y`],
        unchanged: [],
        stale: i.check ? (w.stale ?? []) : [],
        orphaned: [],
      });
    },
  });
  const lint = (name: string, problems: string[] = []) => ({
    execute: async () => {
      calls.push(name);
      return ok({
        problems: problems.map((p) => {
          const [source, message] = p.includes(": ") ? p.split(": ") : ["metator/agents/a.md", p];
          return { severity: "error", source, message };
        }),
      });
    },
  });
  const configured: ConfiguredRepository = {
    installCanon: canon,
    generateHosts: generated("hosts"),
    generateSkills: generated("skills"),
    lintAgents: lint("lint agents", w.agentProblems),
    lintSkills: lint("lint skills"),
    lintWorkflows: lint("lint workflows", w.workflowProblems),
  } as never;
  const d: SetupDependencies = {
    config: { source: w.source, hosts: w.hosts ?? ["claude", "copilot"] },
    installLock: "metator/install.lock.json",
    fs,
    hostsOnPath: () => w.onPath ?? [],
    installCanon: canon as never,
    initProject: {
      execute: async (i: { hosts?: readonly string[] }) => {
        calls.push(`init [${(i.hosts ?? []).join(",")}]`);
        return w.initFails
          ? err(MetatorError.usage("metator.config.yml exists", "Edit it."))
          : ok({ warnings: ["no test script found"], ...(w.initWritten ? { written: w.initWritten } : {}) });
      },
    } as never,
    updateConfig: {
      execute: async (i: { hostTargets?: readonly string[] }) => {
        calls.push(`save hosts [${(i.hostTargets ?? []).join(",")}]`);
        return ok({});
      },
    } as never,
    configured: () => {
      calls.push("reload");
      return w.badConfig ? err(new MetatorError("INVALID_CONFIG", "hosts.targets: bad")) : ok(configured);
    },
  };
  return { use: new SetupRepository(d), fs, calls };
}

describe("SetupRepository", () => {
  test("a fresh repository: config, canon, host files, .gitignore and the checks, in that order, as one report", async () => {
    const w = world({ onPath: ["claude"] });
    const { report, warnings } = (await w.use.execute({ hooks: true }))._unsafeUnwrap();
    expect(w.calls).toEqual([
      "canon install dry",
      "init [claude]",
      "reload",
      "canon install [mt-feature,mt-tiny]",
      "hosts hooks",
      "skills",
      "hosts check",
      "skills check",
      "lint agents",
      "lint skills",
      "lint workflows",
    ]);
    expect(report).toEqual({
      config: "metator.config.yml",
      hosts: ["claude"],
      hostsFrom: "found",
      workflows: ["mt-feature", "mt-tiny"],
      hooks: true,
      canon: {
        mode: "install",
        version: "1.2.3",
        lock: "metator/install.lock.json",
        steps: { add: 2, conflict: 1 },
      },
      generated: 4,
      gitignore: "added",
      checks: SETUP_CHECKS.map((command) => ({ command, passed: true })),
      next: ["metator doctor", "metator doctor --gates", "metator serve"],
      // What a commit of the setup takes (ADR-0105): every file a step wrote, once, sorted.
      written: [".gitignore", "hosts/x", "hosts/y", "metator/install.lock.json", "skills/x", "skills/y"],
    });
    expect(warnings).toEqual([
      "no test script found",
      "metator/agents/c.md: changed here and in the canon; kept yours (--theirs takes the canon's)",
      "metator/agents/old.md: no longer shipped; delete it if nothing of yours depends on it",
    ]);
    expect((await w.fs.read(".gitignore"))._unsafeUnwrap()).toContain(".metator/\n");
  });

  test("written: the config, the canon's created and changed files and its lock, the host files, .gitignore; nothing it left alone", async () => {
    const fresh = world({
      initWritten: "metator.config.yml",
      canonSteps: [
        { action: "create", path: "metator/agents/a.md" },
        { action: "update", path: "metator/agents/b.md" },
        { action: "overwrite", path: "hosts/x" },
        { action: "keep", path: "metator/agents/c.md" },
        { action: "conflict", path: "metator/agents/d.md" },
      ],
    });
    const a = (await fresh.use.execute({ hooks: true }))._unsafeUnwrap().report;
    expect(a.written).toEqual([
      ".gitignore",
      "hosts/x",
      "hosts/y",
      "metator.config.yml",
      "metator/agents/a.md",
      "metator/agents/b.md",
      "metator/install.lock.json",
      "skills/x",
      "skills/y",
    ]);
    // Set up before: the config is saved only when the hosts change, and .gitignore already ignores.
    const again = world({
      source: "metator.config.yml",
      hosts: ["claude"],
      files: { ".gitignore": ".metator/\n" },
    });
    expect((await again.use.execute({ hooks: true }))._unsafeUnwrap().report.written).not.toContain(
      ".gitignore",
    );
    const changed = world({ source: "metator.config.yml", hosts: ["claude"] });
    expect(
      (await changed.use.execute({ hooks: true, hosts: ["copilot"] }))._unsafeUnwrap().report.written,
    ).toContain("metator.config.yml");
    expect(
      (
        await world({ source: "metator.config.yml", hosts: ["claude"] }).use.execute({ hooks: true })
      )._unsafeUnwrap().report.written,
    ).not.toContain("metator.config.yml");
  });

  test("the hosts: the option, else the config's, else what the repository shows, else asked; a change is saved to the config", async () => {
    const option = world({ source: "metator.config.yml", hosts: ["claude"] });
    const a = (await option.use.execute({ hooks: true, hosts: ["copilot"] }))._unsafeUnwrap().report;
    expect([a.hosts, a.hostsFrom, a.config]).toEqual([["copilot"], "option", "metator.config.yml"]);
    expect(option.calls).toContain("save hosts [copilot]");
    expect(option.calls.some((c) => c.startsWith("init"))).toBe(false);

    const config = world({ source: "metator.config.yml", hosts: ["claude"] });
    const b = (await config.use.execute({ hooks: true }))._unsafeUnwrap().report;
    expect([b.hosts, b.hostsFrom]).toEqual([["claude"], "config"]);
    expect(config.calls.some((c) => c.startsWith("save hosts"))).toBe(false);

    const inRepo = world({ files: { "CLAUDE.md": "x" } });
    const c = (await inRepo.use.execute({ hooks: true }))._unsafeUnwrap().report;
    expect([c.hosts, c.hostsFrom]).toEqual([["claude"], "found"]);

    // Nothing says which host: the person is asked, and the hooks with them.
    const asked: unknown[] = [];
    const nothing = world();
    const d = (
      await nothing.use.execute({
        ask: async (q) => {
          asked.push(q.askHosts, q.askHooks, q.defaults.hooks);
          return { hosts: ["copilot"], hooks: true };
        },
      })
    )._unsafeUnwrap().report;
    // The hooks are part of a setup unless the person says no: the question's default is yes.
    expect([asked, d.hosts, d.hostsFrom, d.hooks]).toEqual([[true, true, true], ["copilot"], "asked", true]);
    expect(nothing.calls).toContain("hosts hooks");
  });

  test("the hooks are installed unless the person says no; without them the report says what is missing", async () => {
    // Nothing said, nobody to ask (--yes): the hooks are part of the setup.
    const plain = world({ onPath: ["claude"] });
    const yes = (await plain.use.execute({}))._unsafeUnwrap();
    const missing = (warnings: readonly string[]) =>
      warnings.filter((x) => x.startsWith("hooks are not installed"));
    expect([yes.report.hooks, plain.calls.includes("hosts hooks"), missing(yes.warnings)]).toEqual([
      true,
      true,
      [],
    ]);
    // `--no-hooks`: none are written, nobody is asked about them, and the report says what that costs.
    const without = world({ source: "metator.config.yml" });
    let asked = 0;
    const no = (
      await without.use.execute({
        hooks: false,
        ask: async () => {
          asked++;
          return null;
        },
      })
    )._unsafeUnwrap();
    expect([
      no.report.hooks,
      without.calls.includes("hosts hooks"),
      without.calls.includes("hosts"),
      asked,
    ]).toEqual([false, false, true, 0]);
    expect(missing(no.warnings)).toEqual([
      "hooks are not installed: nothing guards dangerous commands (commit, push, force push), your word in the chat is no consent, and the chat does not hear when you talk to a session. Install them: `metator generate --hooks`",
    ]);
  });

  test("a person who cancels writes nothing; with the hooks given and the hosts known nobody is asked", async () => {
    const w = world();
    const cancelled = (await w.use.execute({ ask: async () => null }))._unsafeUnwrapErr();
    expect([cancelled.code, cancelled.message, cancelled.hint]).toEqual([
      "USAGE",
      "setup cancelled",
      "Nothing was written.",
    ]);
    expect(w.calls).toEqual(["canon install dry"]);
    let asked = 0;
    const known = world({ source: "metator.config.yml" });
    await known.use.execute({
      hooks: true,
      ask: async () => {
        asked++;
        return null;
      },
    });
    expect(asked).toBe(0);
  });

  test("an installed repository is updated; --workflows narrows what is installed", async () => {
    const w = world({ source: "metator.config.yml", files: { "metator/install.lock.json": "{}" } });
    const r = (await w.use.execute({ hooks: true, workflows: ["mt-tiny"] }))._unsafeUnwrap().report;
    expect([r.canon.mode, r.workflows]).toEqual(["update", ["mt-tiny"]]);
    expect(w.calls).toContain("canon update [mt-tiny]");
  });

  test("a check that finds an error, or generated files gone stale, is a check that did not pass", async () => {
    const w = world({ source: "metator.config.yml", agentProblems: ["no description"], stale: ["x.md"] });
    const r = (await w.use.execute({ hooks: true }))._unsafeUnwrap().report;
    expect(r.checks).toEqual([
      { command: "meta agents-lint", passed: false },
      { command: "meta skills-lint", passed: true },
      { command: "workflow lint", passed: true },
      { command: "generate --check", passed: false },
    ]);
  });

  test("a lint that fails only on the repository's own files names them: theirs, not setup's failure", async () => {
    const w = world({
      source: "metator.config.yml",
      workflowProblems: [".github/metator/workflows/old.yml: stage build has no owner"],
      agentProblems: ["metator/agents/b.md: no description"],
    });
    const r = (await w.use.execute({ hooks: true }))._unsafeUnwrap().report;
    expect(r.checks).toEqual([
      { command: "meta agents-lint", passed: false },
      { command: "meta skills-lint", passed: true },
      { command: "workflow lint", passed: false, theirs: [".github/metator/workflows/old.yml"] },
      { command: "generate --check", passed: true },
    ]);
  });

  test("a step that fails stops the setup and names the step with its own error; a config that became invalid is its error", async () => {
    const init = (await world({ initFails: true }).use.execute({ hooks: true }))._unsafeUnwrapErr();
    expect([init.code, init.message, init.hint, init.details]).toEqual([
      "COMMAND_FAILED",
      "setup stopped at `init`: metator.config.yml exists",
      "Edit it.",
      { step: "init", error: { code: "USAGE", message: "metator.config.yml exists", hint: "Edit it." } },
    ]);
    const canon = (
      await world({ source: "metator.config.yml", canonFails: true }).use.execute({ hooks: true })
    )._unsafeUnwrapErr();
    expect(canon.message).toBe("setup stopped at `agents install`: the canon is not here");
    const bad = (await world({ badConfig: true }).use.execute({ hooks: true }))._unsafeUnwrapErr();
    expect(bad.code).toBe("INVALID_CONFIG");
  });
});

describe("ignoreLocalState", () => {
  test(".metator/ is added to .gitignore once: to a new file, after what is there, never twice", async () => {
    const empty = new InMemoryFileSystem({});
    expect((await ignoreLocalState(empty))._unsafeUnwrap()).toBe("added");
    expect((await empty.read(".gitignore"))._unsafeUnwrap()).toBe(
      "# MetatorAI: local state (index, runs, worktrees)\n.metator/\n",
    );
    expect((await ignoreLocalState(empty))._unsafeUnwrap()).toBe("present");
    const some = new InMemoryFileSystem({ ".gitignore": "node_modules" });
    expect((await ignoreLocalState(some))._unsafeUnwrap()).toBe("added");
    expect((await some.read(".gitignore"))._unsafeUnwrap()).toBe(
      "node_modules\n\n# MetatorAI: local state (index, runs, worktrees)\n.metator/\n",
    );
    for (const line of ["/.metator", ".metator/", "/.metator/  "])
      expect(
        (await ignoreLocalState(new InMemoryFileSystem({ ".gitignore": `a\n${line}\n` })))._unsafeUnwrap(),
      ).toBe("present");
  });
});
