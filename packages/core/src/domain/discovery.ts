import { parse } from "shell-quote";
import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * Discovery (ARCHITECTURE §10, ADR-0028): deterministic facts about a repository that the
 * bootstrap agent and `metator init` start from. Every fact names its evidence.
 */
export const CAPABILITIES = ["lint", "format", "typecheck", "test", "e2e", "build"] as const;
export type Capability = (typeof CAPABILITIES)[number];

interface Signal {
  readonly capability: Capability;
  readonly name: RegExp;
  readonly command: RegExp;
}

/** Name and command signals per capability (ARCHITECTURE §10.3). */
const SIGNALS: readonly Signal[] = [
  {
    capability: "e2e",
    name: /^(e2e|test:e2e|playwright)(:.*)?$/,
    command: /\b(playwright test|cypress run)\b/,
  },
  { capability: "lint", name: /^(lint|check)(:.*)?$/, command: /\b(eslint|biome (lint|check|ci)|oxlint)\b/ },
  {
    capability: "format",
    name: /^(format|fmt|prettier)(:.*)?$/,
    command: /\b(prettier|biome format|biome check (--write|--fix)|dprint)\b/,
  },
  {
    capability: "typecheck",
    name: /^(typecheck|type-check|types|tsc)$/,
    // Any tsc run that is not a build (-b/--build) type-checks.
    command: /\b(vue-tsc|tsc)\b(?!\s+(-b|--build)\b)/,
  },
  {
    capability: "test",
    name: /^test(:unit)?$/,
    command: /\b(bun test|vitest( run)?|jest|node --test|mocha)\b/,
  },
  {
    capability: "build",
    name: /^build(:.*)?$/,
    command: /\b(tsc -b|vite build|tsup|bun build|nest build|nx build|turbo build|rollup|webpack)\b/,
  },
];

const GENERIC_NAMES = /^(check|ci|verify|validate|all)(:.*)?$/;

export interface ScriptCandidate {
  readonly capability: Capability;
  readonly confidence: number;
  readonly evidence: readonly string[];
  /** Whether appended file arguments narrow what the script checks. */
  readonly fileScopable: boolean;
  readonly reason: string;
}

/**
 * Splits a composite script (`a && b; c | d`) into its commands; runners like run-p stay one
 * command. Leading environment assignments (`CI=1 jest`) are not part of a command.
 */
export function commandsOf(script: string): string[][] {
  const out: string[][] = [[]];
  for (const token of parse(script)) {
    const current = out[out.length - 1] as string[];
    if (typeof token === "string") {
      if (!(current.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token))) current.push(token);
    } else if ("op" in token && token.op === "glob") current.push(token.pattern);
    else if ("op" in token) out.push([]);
  }
  return out.filter((c) => c.length > 0);
}

/**
 * The tasks a workspace task runner runs (`turbo lint`, `turbo run test:ui build`,
 * `nx run-many -t test lint`, `lerna run test`), or undefined for any other command.
 */
export function runnerTasks(command: readonly string[]): string[] | undefined {
  const tool = (command[0] ?? "").split("/").pop() ?? "";
  const words = (from: number) => {
    const out: string[] = [];
    for (const w of command.slice(from)) {
      if (w.startsWith("-")) break;
      out.push(w);
    }
    return out;
  };
  if (tool === "turbo") return words(command[1] === "run" ? 2 : 1);
  if (tool === "lerna" && command[1] === "run") return words(2);
  if (tool === "nx") {
    const flag = command.findIndex((w) => w === "-t" || w === "--target" || w === "--targets");
    if (flag >= 0) return words(flag + 1).flatMap((w) => w.split(","));
    const inline = command.find((w) => /^--targets?=/.test(w));
    if (inline) return inline.slice(inline.indexOf("=") + 1).split(",");
    return command[1] === "run" || command[1] === "run-many" ? [] : words(1).slice(0, 1);
  }
  return undefined;
}

/** A command that rewrites files (`eslint --fix`, `prettier --write`): a gate must only check. */
const fixes = (command: readonly string[]) => command.some((w) => /^--(fix|write)(=|$)/.test(w));

/** Words that select a tool's mode rather than naming what it checks. */
const SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  biome: ["check", "lint", "format", "ci"],
  bun: ["test", "run"],
  vitest: ["run", "watch", "related"],
  playwright: ["test"],
  cypress: ["run"],
  node: [],
};

/**
 * Appended file arguments narrow a command only when it names no target itself. Any positional
 * argument after the tool's subcommands (`.`, `src`, a glob, a config file) is a target, so the
 * verdict is conservative: when in doubt, "whole".
 */
function fileScopability(command: readonly string[]): { fileScopable: boolean; reason: string } {
  const tool = (command[0] ?? "").split("/").pop() ?? "";
  if (/^(vue-)?tsc$/.test(tool)) return { fileScopable: false, reason: "tsc checks a whole project" };
  const sub = SUBCOMMANDS[tool] ?? [];
  let rest = command.slice(1);
  while (rest[0] && sub.includes(rest[0])) rest = rest.slice(1);
  const target = rest.find((a) => !a.startsWith("-"));
  if (target) {
    return {
      fileScopable: false,
      reason: `the command already targets '${target}', so file arguments will not narrow it`,
    };
  }
  return { fileScopable: true, reason: "no fixed target: appended files narrow the run" };
}

/** Classifies one package.json script by its name and by each command it runs. */
export function classifyScript(name: string, script: string, evidence: string): ScriptCandidate[] {
  const commands = commandsOf(script);
  const out: ScriptCandidate[] = [];
  for (const s of SIGNALS) {
    const byName = s.name.test(name);
    // A task runner's task counts like the tool it runs: `turbo lint` lints, `turbo run test:ui` tests.
    // A task its whole name gives to another capability (`test:e2e`) is not this one by its prefix.
    const runs = (c: readonly string[]) =>
      runnerTasks(c)?.some(
        (t) =>
          s.name.test(t) ||
          (s.name.test(t.split(":")[0] as string) && !SIGNALS.some((o) => o !== s && o.name.test(t))),
      ) ?? false;
    const matching = commands.find((c) => s.command.test(c.join(" ")) || runs(c));
    if (!byName && !matching) continue;
    // A specific name ("test:e2e") wins over another capability's command signal ("bun test e2e");
    // generic names ("check", "ci") do not decide anything on their own.
    if (!byName && !GENERIC_NAMES.test(name) && SIGNALS.some((o) => o !== s && o.name.test(name))) continue;
    const scope = !matching
      ? { fileScopable: false, reason: "no known tool in the command" }
      : runnerTasks(matching)
        ? { fileScopable: false, reason: "a task runner runs it across the workspace" }
        : fileScopability(matching);
    // A script that fixes what it finds is the last choice for a check (format is a fixer by nature).
    const fixer = s.capability !== "format" && matching !== undefined && fixes(matching);
    out.push({
      capability: s.capability,
      confidence: fixer ? 0.3 : byName && matching ? 0.95 : byName ? 0.6 : 0.75,
      evidence: [evidence],
      fileScopable: !fixer && commands.length === 1 && scope.fileScopable,
      reason: fixer
        ? "it rewrites files (--fix/--write); a gate only checks"
        : commands.length > 1
          ? `composite script (${commands.length} commands)`
          : scope.reason,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/** Tools recognized by config files or dev dependencies (ARCHITECTURE §10.2). */
export const TOOL_SIGNATURES: readonly {
  readonly id: string;
  readonly files: readonly string[];
  readonly packages: readonly string[];
}[] = [
  { id: "biome", files: ["biome.json", "biome.jsonc"], packages: ["@biomejs/biome"] },
  {
    id: "eslint",
    files: [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.ts",
      ".eslintrc",
      ".eslintrc.json",
      ".eslintrc.js",
    ],
    packages: ["eslint"],
  },
  {
    id: "prettier",
    files: [".prettierrc", ".prettierrc.json", "prettier.config.js", "prettier.config.mjs"],
    packages: ["prettier"],
  },
  { id: "typescript", files: ["tsconfig.json"], packages: ["typescript"] },
  { id: "ast-grep", files: ["sgconfig.yml"], packages: ["@ast-grep/cli"] },
  {
    id: "vitest",
    files: ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"],
    packages: ["vitest"],
  },
  { id: "jest", files: ["jest.config.js", "jest.config.ts", "jest.config.cjs"], packages: ["jest"] },
  { id: "bun-test", files: ["bunfig.toml"], packages: ["@types/bun", "bun-types"] },
  {
    id: "playwright",
    files: ["playwright.config.ts", "playwright.config.js"],
    packages: ["@playwright/test", "playwright"],
  },
  { id: "nx", files: ["nx.json"], packages: ["nx"] },
  { id: "turborepo", files: ["turbo.json"], packages: ["turbo"] },
];

export const CI_SIGNATURES: readonly { readonly kind: string; readonly globs: readonly string[] }[] = [
  { kind: "github-actions", globs: [".github/workflows/*.yml", ".github/workflows/*.yaml"] },
  { kind: "azure-pipelines", globs: ["azure-pipelines.yml", ".azure-pipelines/*.yml"] },
  { kind: "gitlab-ci", globs: [".gitlab-ci.yml"] },
];

export const AI_SIGNATURES: readonly { readonly host: string; readonly globs: readonly string[] }[] = [
  {
    host: "copilot",
    globs: [
      ".github/copilot-instructions.md",
      ".github/agents/**",
      ".github/prompts/**",
      ".github/instructions/**",
      ".github/skills/**",
    ],
  },
  { host: "claude", globs: ["CLAUDE.md", "**/CLAUDE.md", ".claude/**"] },
  { host: "agents-md", globs: ["AGENTS.md", "**/AGENTS.md"] },
  { host: "cursor", globs: [".cursor/**", ".cursorrules"] },
];

/** `git@github.com:o/r.git`, `https://dev.azure.com/...` → the code host kind. */
export function codeHostOf(remote: string): "github" | "azure-devops" | "gitlab" | "other" {
  if (/github\.com[:/]/.test(remote)) return "github";
  if (/dev\.azure\.com|visualstudio\.com/.test(remote)) return "azure-devops";
  if (/gitlab\./.test(remote)) return "gitlab";
  return "other";
}

const Evidence = z.array(z.string());

export const DiscoverySchema = z.strictObject({
  packageManager: z
    .strictObject({ name: z.string(), version: z.string().optional(), lockfiles: z.array(z.string()) })
    .nullable(),
  workspaces: z.array(z.strictObject({ name: z.string(), dir: z.string() })),
  scripts: z.array(
    z.strictObject({
      package: z.string(),
      dir: z.string(),
      name: z.string(),
      command: z.string(),
      candidates: z.array(
        z.strictObject({
          capability: z.enum(CAPABILITIES),
          confidence: z.number(),
          evidence: Evidence,
          fileScopable: z.boolean(),
          reason: z.string(),
        }),
      ),
    }),
  ),
  tools: z.array(z.strictObject({ id: z.string(), evidence: Evidence })),
  ci: z.array(z.strictObject({ kind: z.string(), files: z.array(z.string()) })),
  codeHost: z.strictObject({ kind: z.string(), remote: z.string() }).nullable(),
  docs: z.strictObject({ adr: z.string().nullable(), codeowners: z.string().nullable() }),
  ai: z.array(z.strictObject({ host: z.string(), files: z.array(z.string()) })),
  warnings: z.array(z.string()),
});
export type Discovery = z.output<typeof DiscoverySchema>;

export const DiscoveryDocument = defineDocument("Discovery", { latest: DiscoverySchema });
