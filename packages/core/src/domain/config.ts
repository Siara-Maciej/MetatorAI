import { z } from "zod";
import { ModelTierSchema } from "./agent.ts";
import { IntakeConfigSchema } from "./intake.ts";
import { McpServersSchema } from "./mcp.ts";
import { ReviewsConfigSchema } from "./review-thread.ts";
import { defineDocument } from "./versioned.ts";

/**
 * `metator.config.yml` / `.json` (ADR-0004, ADR-0029): the repository's choices layered over
 * MetatorAI's defaults. Version 1 covered paths, project globs and gates; each later version below
 * says what it added.
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

/** The hosts whose files a repository already holds (`paths`: its files, repo-relative). */
export function repositoryHosts(paths: readonly string[]): HostTarget[] {
  const signs: Record<HostTarget, RegExp> = {
    copilot: /^\.github\/(copilot[^/]*|(agents|skills|prompts|instructions)\/.+)$/,
    claude: /^(\.claude\/.+|CLAUDE\.md)$/,
  };
  return HOST_TARGETS.filter((h) => paths.some((p) => signs[h].test(p)));
}

/**
 * The hosts `metator setup` generates for, from what is there: the hosts the repository already
 * has files of, else the hosts whose command is on this machine. `ask` when nothing says (every
 * host is a candidate) or the two point at different hosts (both are).
 */
export function hostsFromEvidence(evidence: {
  readonly repository: readonly HostTarget[];
  readonly machine: readonly HostTarget[];
}): { readonly hosts: HostTarget[]; readonly ask: boolean } {
  const { repository, machine } = evidence;
  const ordered = (hosts: readonly HostTarget[]) => HOST_TARGETS.filter((h) => hosts.includes(h));
  if (repository.length === 0)
    return machine.length === 0
      ? { hosts: [...HOST_TARGETS], ask: true }
      : { hosts: ordered(machine), ask: false };
  const disjoint = machine.length > 0 && !machine.some((h) => repository.includes(h));
  return disjoint
    ? { hosts: ordered([...repository, ...machine]), ask: true }
    : { hosts: ordered(repository), ask: false };
}

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

/**
 * v6 adds `notify` (P5): a command run when a question waits for a person, the question as JSON
 * in `METATOR_QUESTION`. Every v5 file is a v6 file.
 */
const ConfigV6Schema = z.strictObject({
  ...ConfigV5Schema.shape,
  notify: z
    .strictObject({
      /** A shell command, e.g. `notify-send "$METATOR_QUESTION_PROMPT"` or a curl to a chat webhook. */
      command: z.string().min(1),
    })
    .optional(),
});

/**
 * v7 adds `supervisor` (D4, ADR-0077): how the daemon keeps sessions alive and how much a person
 * is asked at once. Every v6 file is a v7 file (every field has a default).
 */
export const SupervisorPolicySchema = z.strictObject({
  /** How many runs may wait for a person at once before new ones start with a warning. */
  wipLimit: z.number().int().min(1).default(4),
  respawn: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Restarts of one run's drive before the supervisor gives up and says so. */
      maxAttempts: z.number().int().min(0).default(3),
    })
    .default({ enabled: true, maxAttempts: 3 }),
  /** No terminal output for this long, with no open question, is idleness. */
  idleThresholdMs: z.number().int().min(1000).default(90_000),
  /** Which interactive host a new session takes first. */
  hostOrder: z.array(z.string().min(1)).default(["copilot", "claude", "opencode"]),
  /** An approval said in the chat counts only while the person is attached. */
  chatApprovals: z.enum(["attached-only"]).default("attached-only"),
});
export type SupervisorPolicy = z.output<typeof SupervisorPolicySchema>;

const ConfigV7Schema = z.strictObject({
  ...ConfigV6Schema.shape,
  supervisor: SupervisorPolicySchema.default(SupervisorPolicySchema.parse({})),
});

/**
 * v8 adds `options` (S1, design/13): repository-scope options by dotted key (`supervisor.wipLimit`,
 * `review.sendTo`), checked per key when read so a wrong value is a diagnostic, not an invalid
 * config. Every v7 file is a v8 file.
 */
const ConfigV8Schema = z.strictObject({
  ...ConfigV7Schema.shape,
  options: z.record(z.string().min(1), z.unknown()).default({}),
});

/**
 * v9 adds `mcp` (T1, design/14 §2): the MCP servers the agents may use in this repository, by
 * name; `metator generate` writes them into the hosts' `.mcp.json`. Every v8 file is a v9 file.
 */
const ConfigV9Schema = z.strictObject({
  ...ConfigV8Schema.shape,
  mcp: McpServersSchema,
});

/**
 * v10 adds `intake` (T2, design/14 §3): the rules that turn outside items into issues and runs.
 * Every v9 file is a v10 file.
 */
const ConfigV10Schema = z.strictObject({
  ...ConfigV9Schema.shape,
  intake: IntakeConfigSchema.default(IntakeConfigSchema.parse({})),
});

/**
 * v11 adds `reviews` (T3, design/14 §4): where to look for reviews of my own requests and the
 * workflow that answers them. Every v10 file is a v11 file.
 */
const ConfigV11Schema = z.strictObject({
  ...ConfigV10Schema.shape,
  reviews: ReviewsConfigSchema.default(ReviewsConfigSchema.parse({})),
});

/**
 * v12 takes the local state out of `paths` (`runs`, `index`, `discovery`, `gates`): it always lives
 * under `.metator/`, which git, the hooks and a run's worktree treat as MetatorAI's own. An
 * override moved the files and nothing else, so a run's change then counted them and the edit
 * guard refused to write them. The migration drops the four keys; the canon's paths stay.
 */
export const LOCAL_STATE_PATHS = ["runs", "index", "discovery", "gates"] as const;
/** The same keys as paths into a config file, for a rewrite that keeps the file's comments. */
export const RETIRED_CONFIG_KEYS: readonly (readonly string[])[] = LOCAL_STATE_PATHS.map((k) => ["paths", k]);
const ConfigV12Schema = z.strictObject({
  ...ConfigV11Schema.shape,
  paths: PathOverrides.omit({ runs: true, index: true, discovery: true, gates: true }).default({}),
});

/** A config body as the current version holds it: an older file's keys that are gone are left out. */
export function withoutLocalStatePaths(v11: unknown): unknown {
  const config = v11 as { paths?: Record<string, unknown> };
  if (!config.paths) return v11;
  const paths = Object.fromEntries(
    Object.entries(config.paths).filter(([key]) => !(LOCAL_STATE_PATHS as readonly string[]).includes(key)),
  );
  return { ...config, paths };
}

export const MetatorConfigSchema = ConfigV12Schema;
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
    { schema: ConfigV5Schema, fromPrevious: (v4) => v4 },
    { schema: ConfigV6Schema, fromPrevious: (v5) => v5 },
    { schema: ConfigV7Schema, fromPrevious: (v6) => v6 },
    { schema: ConfigV8Schema, fromPrevious: (v7) => v7 },
    { schema: ConfigV9Schema, fromPrevious: (v8) => v8 },
    { schema: ConfigV10Schema, fromPrevious: (v9) => v9 },
    { schema: ConfigV11Schema, fromPrevious: (v10) => v10 },
  ],
  latest: MetatorConfigSchema,
  upgrade: withoutLocalStatePaths,
  errorCode: "INVALID_CONFIG",
  hint: "Fix metator.config; `metator config schema` prints the JSON Schema.",
});

export const CONFIG_FILES = ["metator.config.yml", "metator.config.yaml", "metator.config.json"] as const;

/** An empty config: every default applies. */
export const DEFAULT_CONFIG: MetatorConfig = MetatorConfigSchema.parse({});
