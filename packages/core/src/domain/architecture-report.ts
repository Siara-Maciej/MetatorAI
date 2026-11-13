import { z } from "zod";
import { DEPENDENCY_FIELDS } from "./architecture-manifests.ts";
import { VIOLATION_KINDS, VIOLATION_KINDS_V1 } from "./architecture-policy.ts";
import { defineDocument } from "./versioned.ts";

/** The `ArchitectureReport` document: what `analyzeArchitecture` computes, as it is written to disk. */

const Name = z.string().min(1);
const Evidence = z.strictObject({
  file: z.string(),
  to: z.string().optional(),
  specifier: z.string().optional(),
});

const violationSchema = <K extends readonly [string, ...string[]]>(kinds: K) =>
  z.strictObject({
    /** Stable across runs (`kind:subject`): baselines and exceptions refer to it. */
    id: z.string().min(1),
    kind: z.enum(kinds),
    severity: z.enum(["error", "warning"]),
    message: z.string(),
    packages: z.array(Name),
    evidence: z.array(Evidence),
    /** Set when a policy exception covers the violation; it then does not count. */
    exception: z.strictObject({ reason: z.string(), owner: z.string(), expires: z.string() }).optional(),
  });
const ViolationSchema = violationSchema(VIOLATION_KINDS);
export type Violation = z.output<typeof ViolationSchema>;

const MetricsSchema = z.strictObject({
  /** Afferent coupling: workspace packages that depend on this one. */
  ca: z.number().int().nonnegative(),
  /** Efferent coupling: workspace packages this one depends on. */
  ce: z.number().int().nonnegative(),
  /** Ce / (Ca + Ce); 0 is maximally stable. */
  instability: z.number().min(0).max(1),
  /** Share of exported symbols that are types and interfaces. */
  abstractness: z.number().min(0).max(1),
  /** |A + I − 1|: distance from the main sequence. */
  distance: z.number().min(0).max(1),
  /** The longest dependency chain below the package. */
  depth: z.number().int().nonnegative(),
  /** Share of the exported symbols other packages import (null without exports). */
  exportsUsed: z.number().min(0).max(1).nullable(),
});

const PackageSchema = z.strictObject({
  name: Name,
  dir: z.string(),
  kind: z.enum(["app", "lib", "root"]),
  tags: z.array(z.string()),
  layer: z.string().optional(),
  files: z.number().int().nonnegative(),
  testFiles: z.number().int().nonnegative(),
  owners: z.array(z.string()),
  dependsOn: z.array(Name),
  dependents: z.array(Name),
  metrics: MetricsSchema.optional(),
});
export type ArchPackage = z.output<typeof PackageSchema>;

const EdgeSchema = z.strictObject({
  from: Name,
  to: Name,
  /** Import statements from files of `from` to files of `to`. */
  imports: z.number().int().positive(),
  /** Of them, the ones that are not `import type`. */
  runtime: z.number().int().nonnegative(),
  /** Every import comes from a test file. */
  testOnly: z.boolean(),
  declared: z.enum([...DEPENDENCY_FIELDS, "none"]),
  samples: z.array(z.strictObject({ from: z.string(), to: z.string() })).max(5),
});
export type ArchEdge = z.output<typeof EdgeSchema>;

const CycleSchema = z.strictObject({
  packages: z.array(Name).min(2),
  edges: z.array(
    z.strictObject({ from: Name, to: Name, imports: z.number().int(), runtime: z.number().int() }),
  ),
  /** The cycle closes only through `import type`. */
  typeOnly: z.boolean(),
  /** The cheapest edges to remove so that no cycle is left (fewest imports to move). */
  cut: z.array(z.strictObject({ from: Name, to: Name, imports: z.number().int() })).optional(),
});
export type ArchCycle = z.output<typeof CycleSchema>;

const BoundariesSchema = z.strictObject({
  /** Groups of files inside one package that import each other but not the rest, used by different packages. */
  split: z.array(
    z.strictObject({
      package: Name,
      clusters: z.array(
        z.strictObject({
          files: z.number().int().positive(),
          sample: z.array(z.string()),
          consumers: z.array(Name),
        }),
      ),
    }),
  ),
  /** Packages with exactly one dependent that could live inside it. */
  merge: z.array(z.strictObject({ package: Name, into: Name, reason: z.string() })),
  /** Packages many depend on and that depend on many. */
  hubs: z.array(z.strictObject({ package: Name, fanIn: z.number().int(), fanOut: z.number().int() })),
  /** Exported symbols no other file imports. */
  deadExports: z.array(z.strictObject({ package: Name, file: z.string(), name: z.string() })),
  /** Library packages nothing depends on. */
  deadPackages: z.array(Name),
});

const CouplingSchema = z.strictObject({
  a: Name,
  b: Name,
  /** Commits that changed both packages. */
  together: z.number().int().positive(),
  /** together / commits that changed either. */
  ratio: z.number().min(0).max(1),
  dependency: z.enum(["none", "a-to-b", "b-to-a", "both"]),
});

const TeamsSchema = z.strictObject({
  edges: z.array(z.strictObject({ from: z.string(), to: z.string(), imports: z.number().int() })),
  unowned: z.array(Name),
});

const AppsSchema = z.strictObject({
  /** Every workspace package each application pulls in. */
  closure: z.array(z.strictObject({ app: Name, packages: z.array(Name) })),
  /** Applications a change to each package reaches, widest first. */
  blastRadius: z.array(z.strictObject({ package: Name, apps: z.array(Name) })),
});

const ModuleRefs = z.array(z.strictObject({ from: z.string(), to: z.string() })).max(5);

/** Modules inside packages (ADR-0074): the units of a modular monolith and how they depend. */
const ModulesSchema = z.strictObject({
  globs: z.array(z.string()),
  public: z.array(z.string()).optional(),
  modules: z.array(
    z.strictObject({
      name: z.string(),
      dir: z.string(),
      files: z.number().int().nonnegative(),
      dependsOn: z.array(z.string()),
      dependents: z.array(z.string()),
    }),
  ),
  edges: z.array(
    z.strictObject({
      from: z.string(),
      to: z.string(),
      imports: z.number().int().positive(),
      runtime: z.number().int().nonnegative(),
      samples: ModuleRefs,
      /** Imports of files outside the target's public part. */
      internal: z.number().int().nonnegative(),
      internalSamples: ModuleRefs,
    }),
  ),
  twoWay: z.array(z.tuple([z.string(), z.string()])),
  cycles: z.array(
    z.strictObject({
      modules: z.array(z.string()).min(2),
      edges: z.array(z.strictObject({ from: z.string(), to: z.string(), imports: z.number().int() })),
      typeOnly: z.boolean(),
    }),
  ),
});

const reportFields = <K extends readonly [string, ...string[]]>(kinds: K) => ({
  /** The policy file used, or null for the defaults. */
  policy: z.string().nullable(),
  summary: z.strictObject({
    packages: z.number().int(),
    apps: z.number().int(),
    edges: z.number().int(),
    cycles: z.number().int(),
    errors: z.number().int(),
    warnings: z.number().int(),
    /** Violations a policy exception covers. */
    excepted: z.number().int(),
    /** 100 minus 5 per error and 1 per warning, never below 0. */
    score: z.number().int().min(0).max(100),
  }),
  packages: z.array(PackageSchema),
  edges: z.array(EdgeSchema),
  cycles: z.array(CycleSchema),
  violations: z.array(violationSchema(kinds)),
  boundaries: BoundariesSchema.optional(),
  coupling: z.array(CouplingSchema).optional(),
  teams: TeamsSchema.optional(),
  apps: AppsSchema.optional(),
  /** Imports the analyzer could not resolve: the limit of what this report can see. */
  unresolved: z.strictObject({
    count: z.number().int(),
    sample: z.array(z.strictObject({ from: z.string(), specifier: z.string() })).max(50),
  }),
});

export const ArchitectureReportSchema = z.strictObject({
  ...reportFields(VIOLATION_KINDS),
  modules: ModulesSchema.optional(),
});
export type ArchitectureReport = z.output<typeof ArchitectureReportSchema>;

export const ArchitectureReportDocument = defineDocument("ArchitectureReport", {
  history: [{ schema: z.strictObject(reportFields(VIOLATION_KINDS_V1)) }],
  latest: ArchitectureReportSchema,
  // Version 2 only adds: the modules section and two violation kinds.
  upgrade: (v1) => v1,
});
