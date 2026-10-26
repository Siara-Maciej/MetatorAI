import { z } from "zod";
import { ModelTierSchema } from "./agent.ts";
import { defineDocument } from "./versioned.ts";

/**
 * `metator.config.yml` / `.json` (ADR-0004, ADR-0029): the repository's choices layered over
 * MetatorAI's defaults. Version 1 covers paths, project globs and gates.
 */
export const GateStepSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9:-]*$/, "expected a short id, e.g. lint or test:affected"),
  run: z.union([
    z
      .strictObject({ script: z.string().min(1) })
      .describe("package.json script, run by the repo's package manager"),
    z
      .strictObject({ bin: z.string().min(1), args: z.array(z.string()).default([]) })
      .describe("binary from node_modules/.bin"),
    z.strictObject({ metator: z.enum(["rules check"]) }).describe("a MetatorAI check, run in process"),
  ]),
  /** append: the gate's files are appended as arguments (only for file-scopable commands). */
  files: z.enum(["append", "none"]).default("none"),
  /** With files: append, only files matching these globs are passed (e.g. a linter's languages). */
  match: z.array(z.string()).optional(),
  /** Exit codes that mean "ran fine" (a linter may exit 1 with findings reported via parser). */
  okExitCodes: z.array(z.number().int()).default([0]),
  timeoutMs: z.number().int().positive().default(600_000),
});
export type GateStep = z.output<typeof GateStepSchema>;

const PathOverrides = z
  .strictObject({
    workflows: z.string(),
    runs: z.string(),
    index: z.string(),
    rules: z.string(),
    instructions: z.string(),
    memoryMap: z.string(),
    cards: z.string(),
    patterns: z.string(),
    adr: z.string(),
    discovery: z.string(),
    gates: z.string(),
    agents: z.string(),
  })
  .partial();

export const MetatorConfigSchema = z.strictObject({
  paths: PathOverrides.default({}),
  project: z
    .strictObject({
      /** Files the import graph and knowledge scans never look at. */
      sourceIgnores: z.array(z.string()).optional(),
      testGlobs: z.array(z.string()).optional(),
    })
    .default({}),
  gates: z
    .strictObject({ quick: z.array(GateStepSchema).default([]), full: z.array(GateStepSchema).default([]) })
    .default({ quick: [], full: [] }),
  /** Generated host files (ADR-0030). Optional, so every v1 file stays valid. */
  hosts: z
    .strictObject({
      targets: z.array(z.enum(["copilot", "claude"])).default(["copilot", "claude"]),
      /** How agents call MetatorAI in this repo, e.g. "npx metator" or "bun run metator". */
      metatorCommand: z.string().default("metator"),
      /** Model per tier and host; a host without an entry uses its default for the tier (or none). */
      models: z
        .partialRecord(
          ModelTierSchema,
          z.strictObject({ copilot: z.string().optional(), claude: z.string().optional() }),
        )
        .default({}),
    })
    .default({ targets: ["copilot", "claude"], metatorCommand: "metator", models: {} }),
});
export type MetatorConfig = z.output<typeof MetatorConfigSchema>;

export const MetatorConfigDocument = defineDocument("MetatorConfig", {
  latest: MetatorConfigSchema,
  errorCode: "INVALID_CONFIG",
  hint: "Fix metator.config; `metator config schema` prints the JSON Schema.",
});

export const CONFIG_FILES = ["metator.config.yml", "metator.config.yaml", "metator.config.json"] as const;

/** An empty config: every default applies. */
export const DEFAULT_CONFIG: MetatorConfig = MetatorConfigSchema.parse({});
