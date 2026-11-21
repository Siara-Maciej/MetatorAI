import { MetatorError } from "../domain/errors.ts";
import { matchesAny } from "../domain/glob.ts";
import {
  type QuickFacts,
  type QuickLimitsOf,
  type QuickVerdict,
  quickCheck,
  taskFiles,
} from "../domain/quick.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { ChangePatch, Vcs, WorkspaceReader } from "../ports/index.ts";
import type { GraphQueries } from "./import-graph.ts";
import type { SystemImpactQuery } from "./system-sources.ts";

export interface QuickCheckDependencies {
  /** `quick` of the config: the limits of a quick change. */
  readonly limits: QuickLimitsOf;
  readonly testGlobs: readonly string[];
  readonly vcs: Pick<Vcs, "changedFiles">;
  readonly patch: Pick<ChangePatch, "patch">;
  readonly workspace: Pick<WorkspaceReader, "packages">;
  readonly graph: Pick<GraphQueries, "dependents">;
  /** The system map's view (`system impact`); an error (no map here) means one repository. */
  readonly impact: Pick<SystemImpactQuery, "execute">;
  readonly exists: (file: string) => Promise<boolean>;
  /** Whether a package's public API differs from its snapshot (`api diff`); undefined: no snapshot to compare. */
  readonly apiChanged?: (pkg: string) => Promise<boolean | undefined>;
}

/** Source files a test should reach (the languages the import graph reads). */
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** A package's entry module: changing it changes what the package exports. */
const ENTRY = /^(src\/)?index\.(ts|tsx|mts|js|mjs)$/;

/**
 * `metator quick check` (ADR-0093): the facts of a change from the tools that already exist (the
 * working tree's diff, the workspace's packages, the import graph, the API snapshots, the system
 * map), then `quickCheck`. No model is asked. `files` names what a change is expected to touch
 * (before it starts); `diff` reads what the working tree changed (after the build).
 */
export class QuickCheck {
  constructor(private readonly d: QuickCheckDependencies) {}

  async execute(input: {
    readonly files?: readonly string[];
    readonly diff?: boolean;
    /** The task in the person's words: the files it names and what its words say. */
    readonly task?: string;
  }): Promise<Result<QuickVerdict & { readonly files: readonly string[] }, MetatorError>> {
    let files = [...(input.files ?? [])];
    // A file the task names counts when it is there: a word with a dot is not always a file.
    for (const named of input.task ? taskFiles(input.task) : [])
      if (!files.includes(named) && (await this.d.exists(named))) files.push(named);
    let patch: string | undefined;
    if (input.diff) {
      const changed = await this.d.vcs.changedFiles("HEAD");
      if (changed.isErr()) return err(changed.error);
      files = [...new Set([...files, ...changed.value])];
      if (files.length > 0) {
        const text = await this.d.patch.patch("HEAD", files);
        if (text.isErr()) return err(text.error);
        patch = text.value;
      }
    } else if (files.length === 0 && input.task === undefined)
      return err(
        MetatorError.usage(
          'say what to check: the files the change touches (--files a,b), the working tree\'s diff (--diff), or the task (--task "<text>")',
        ),
      );

    // The packages the files are in: more than one is a boundary; an entry module is the public API.
    const listed = await this.d.workspace.packages();
    const packages = listed.isOk() ? [...listed.value].sort((a, b) => b.dir.length - a.dir.length) : [];
    const owners = new Set<string>();
    const publicApi = new Set<string>();
    for (const file of files) {
      const pkg = packages.find((p) => p.dir === "." || file.startsWith(`${p.dir}/`));
      if (!pkg) continue;
      owners.add(pkg.name);
      const inside = pkg.dir === "." ? file : file.slice(pkg.dir.length + 1);
      if (ENTRY.test(inside)) publicApi.add(pkg.name);
    }
    if (this.d.apiChanged && input.diff)
      for (const name of owners) if ((await this.d.apiChanged(name)) === true) publicApi.add(name);

    // What depends on the change, and whether a test reaches each changed source file.
    const dependents = new Set<string>();
    const untested: string[] = [];
    for (const file of files) {
      if (!CODE.test(file) || matchesAny(file, this.d.testGlobs) || !(await this.d.exists(file))) continue;
      const found = await this.d.graph.dependents(file, true);
      // A file the graph does not know (generated, ignored) says nothing either way.
      if (found.isErr()) continue;
      for (const f of found.value) if (!files.includes(f)) dependents.add(f);
      const tested =
        found.value.some((f) => matchesAny(f, this.d.testGlobs)) ||
        files.some((f) => matchesAny(f, this.d.testGlobs) && found.value.includes(f));
      if (!tested) untested.push(file);
    }

    // The system map, when this repository has one: contracts touched, other applications reached.
    const impact = await this.d.impact.execute({ files });
    const contracts = impact.isOk() ? impact.value.contracts.map((c) => c.id) : [];
    const repositories = impact.isOk()
      ? impact.value.applications.filter((a) => !impact.value.self.includes(a.id)).map((a) => a.id)
      : [];

    const facts: QuickFacts = {
      files,
      ...(patch !== undefined ? { patch } : {}),
      packages: [...owners].sort(),
      // Tests are not what depends on a change: they follow it.
      dependents: [...dependents].filter((f) => !matchesAny(f, this.d.testGlobs)).length,
      publicApi: [...publicApi].sort(),
      untested,
      contracts,
      repositories,
      ...(input.task !== undefined ? { task: input.task } : {}),
    };
    return ok({ ...quickCheck(facts, this.d.limits), files });
  }
}
