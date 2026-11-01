import { z } from "zod";
import { ModelTierSchema } from "./agent.ts";
import { defineDocument } from "./versioned.ts";

/**
 * `metator.config.yml` / `.json` (ADR-0004, ADR-0029): the repository's choices layered over
 * MetatorAI's defaults. Version 1 covers paths, project globs and gates.
 */
/** MetatorAI checks a gate step may run in process (v2; v1 knew only `rules check`). */
export type MetatorStep =
  | { readonly command: "rules check" }
  | { readonly command: "test affected" }
  | { readonly command: "graph diff" }
  | { readonly command: "arch check" }
  | { readonly command: "contract diff" }
  | { readonly command: "api diff"; readonly package: string }
  | { readonly command: "coverage diff"; readonly min?: number; readonly lcov?: string };

export function parseMetatorStep(text: string): MetatorStep | undefined {
  if (
    text === "rules check" ||
    text === "test affected" ||
    text === "graph diff" ||
    text === "arch check" ||
    text === "contract diff"
  )
    return { command: text };
  const api = /^api diff (\S+)$/.exec(text);
  if (api) return { command: "api diff", package: api[1] as string };
  const cov = /^coverage diff(?: --min (\d{1,3}))?(?: --lcov (\S+))?$/.exec(text);
  if (cov)
    return {
      command: "coverage diff",
      ...(cov[1] ? { min: Number(cov[1]) } : {}),
      ...(cov[2] ? { lcov: cov[2] } : {}),
    };
  return undefined;
}

const METATOR_STEPS =
  "rules check, test affected, graph diff, arch check, contract diff, api diff <package>, coverage diff [--min <percent>] [--lcov <file>]";

function runSchemas<M extends z.ZodType<string>>(metator: M) {
  return [
    z
      .strictObject({ script: z.string().min(1) })
      .describe("package.json script, run by the repo's package manager"),
    z
      .strictObject({ bin: z.string().min(1), args: z.array(z.string()).default([]) })
      .describe("binary from node_modules/.bin"),
    z.strictObject({ metator }).describe("a MetatorAI check, run in process"),
  ] as const;
}

/** v5: a package.json script of every workspace package that has it (`pnpm -r --if-present run x`). */
const WorkspacesRun = z
  .strictObject({ workspaces: z.string().min(1) })
  .describe("the script in every workspace package that has it, run by the repo's package manager");

function gateStepSchema<M extends z.ZodType<string>, R extends z.ZodType>(metator: M, run?: R) {
  const runs = runSchemas(metator);
  return z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9:-]*$/, "expected a short id, e.g. lint or test:affected"),
    run: (run ?? z.union(runs)) as R extends z.ZodType ? R : z.ZodUnion<typeof runs>,
    /** append: the gate's files are appended as arguments (only for file-scopable commands). */
    files: z.enum(["append", "none"]).default("none"),
    /** With files: append, only files matching these globs are passed (e.g. a linter's languages). */
    match: z.array(z.string()).optional(),
    /** Exit codes that mean "ran fine" (a linter may exit 1 with findings reported via parser). */
    okExitCodes: z.array(z.number().int()).default([0]),
    timeoutMs: z.number().int().positive().default(600_000),
  });
}

/** v1 (released): `metator` runs only `rules check`. Never change it (MT-CODE-003). */
const GateStepV1Schema = gateStepSchema(z.enum(["rules check"]));
const metatorStep = z
  .string()
  .refine((t) => parseMetatorStep(t) !== undefined, `expected one of: ${METATOR_STEPS}`);
/** v2–v4 gate steps. Never change them. */
const GateStepV4Schema = gateStepSchema(metatorStep);
export const GateStepSchema = gateStepSchema(
  metatorStep,
  z.union([...runSchemas(metatorStep), WorkspacesRun]),
);
export type GateStep = z.output<typeof GateStepSchema>;

/** The AI hosts MetatorAI generates agents, skills and hooks for. */
export const HOST_TARGETS = ["copilot", "claude"] as const;
export type HostTarget = (typeof HOST_TARGETS)[number];

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
    evals: z.string(),
  })
  .partial();

type AnyGateStep = typeof GateStepSchema | typeof GateStepV4Schema | typeof GateStepV1Schema;

function configSchema<S extends AnyGateStep>(step: S) {
  return z.strictObject(configFields(step));
}

/** v3 adds the person's editor for `metator ui` (ADR-0054); every v2 file is a valid v3 file. */
const ConfigV3Schema = z.strictObject({
  ...configFields(GateStepV4Schema),
  /** The command that opens a directory in the person's editor, e.g. "code" or "nvim". */
  editor: z.string().min(1).optional(),
});

function configFields<S extends AnyGateStep>(step: S) {
  return {
    paths: PathOverrides.default({}),
    project: z
      .strictObject({
        /** Files the import graph and knowledge scans never look at. */
        sourceIgnores: z.array(z.string()).optional(),
        testGlobs: z.array(z.string()).optional(),
      })
      .default({}),
    gates: z
      .strictObject({ quick: z.array(step).default([]), full: z.array(step).default([]) })
      .default({ quick: [], full: [] }),
    /** Generated host files (ADR-0030). Optional, so every v1 file stays valid. */
    hosts: z
      .strictObject({
        targets: z.array(z.enum(HOST_TARGETS)).default([...HOST_TARGETS]),
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
  };
}

/**
 * v4 adds `system` (F7.3, ADR-0068): where the system map is (this repository, or a platform
 * repository at a pinned ref), where other applications are checked out on this machine, and
 * which applications of the map this repository is. Every v3 file is a valid v4 file.
 */
const SystemSettings = z.strictObject({
  map: z
    .union([
      z.strictObject({ path: z.string().min(1) }),
      z.strictObject({
        /** A git URL or a path to the repository that holds the map. */
        repo: z.string().min(1),
        /** Pinned commit, tag or branch (default: the default branch). */
        ref: z.string().min(1).optional(),
        path: z.string().min(1).default("docs/metator/system.yml"),
      }),
    ])
    .optional(),
  /** Application id → its local checkout (relative to this repository or absolute). */
  roots: z.record(z.string(), z.string().min(1)).default({}),
  /** The applications of the map this repository is (default: found by its remote or path). */
  self: z.array(z.string().min(1)).optional(),
});
const ConfigV4Schema = z.strictObject({
  ...ConfigV3Schema.shape,
  system: SystemSettings.optional(),
});

/** v5 adds the `workspaces` gate step: a script of every workspace package. Every v4 file is a v5 file. */
const ConfigV5Schema = z.strictObject({
  ...ConfigV4Schema.shape,
  ...configFields(GateStepSchema),
  editor: ConfigV4Schema.shape.editor,
});

export const MetatorConfigSchema = ConfigV5Schema;
export type SystemSettings = z.output<typeof SystemSettings>;
export type MetatorConfig = z.output<typeof MetatorConfigSchema>;

/**
 * v2 widens gate steps to every MetatorAI check; every v1 file is a valid v2 file.
 * v3 adds `editor`; every v2 file is a valid v3 file. v4 adds `system`; every v3 file is a valid v4 file.
 */
export const MetatorConfigDocument = defineDocument("MetatorConfig", {
  history: [
    { schema: configSchema(GateStepV1Schema) },
    { schema: configSchema(GateStepV4Schema), fromPrevious: (v1) => v1 },
    { schema: ConfigV3Schema, fromPrevious: (v2) => v2 },
    { schema: ConfigV4Schema, fromPrevious: (v3) => v3 },
  ],
  latest: MetatorConfigSchema,
  upgrade: (v4) => v4,
  errorCode: "INVALID_CONFIG",
  hint: "Fix metator.config; `metator config schema` prints the JSON Schema.",
});

export const CONFIG_FILES = ["metator.config.yml", "metator.config.yaml", "metator.config.json"] as const;

/** An empty config: every default applies. */
export const DEFAULT_CONFIG: MetatorConfig = MetatorConfigSchema.parse({});
