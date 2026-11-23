import type { GateStep } from "./config.ts";
import { type Capability, commandsOf, type Discovery, runnerTasks } from "./discovery.ts";
import { buildProgram, JVM_FILES, jvmGateSteps, wrapperOf } from "./jvm-build.ts";

/**
 * Config proposal from discovery (`metator init`, ARCHITECTURE §10.1 B7). Deterministic: the
 * same discovery gives the same proposal, and every decision names its evidence, so a person
 * (or the bootstrap agent) can accept or change it.
 */
export interface Decision {
  readonly capability: Capability | "rules";
  readonly gate: "quick" | "full";
  readonly step: string;
  readonly evidence: readonly string[];
  readonly reason: string;
}

export interface Proposal {
  readonly gates: { readonly quick: readonly GateStep[]; readonly full: readonly GateStep[] };
  readonly decisions: readonly Decision[];
}

/** Per-file tools for the quick gate when the project's script cannot be scoped to files. */
const FILE_TOOLS: Readonly<
  Partial<Record<Capability, readonly { tool: string; bin: string; args: readonly string[] }[]>>
> = {
  lint: [
    {
      tool: "biome",
      bin: "biome",
      args: ["check", "--files-ignore-unknown=true", "--no-errors-on-unmatched"],
    },
    { tool: "eslint", bin: "eslint", args: ["--no-warn-ignored"] },
  ],
};

/** Files JS/TS linters accept; other changed files (docs, lockfiles) are not passed to them. */
export const SCRIPT_FILES = ["**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"];

const step = (id: string, run: GateStep["run"], files: GateStep["files"] = "none"): GateStep => ({
  id,
  run,
  files,
  ...(files === "append" ? { match: [...SCRIPT_FILES] } : {}),
  okExitCodes: [0],
  timeoutMs: 600_000,
});

export function proposeConfig(discovery: Discovery, options: { readonly ruleCanon: boolean }): Proposal {
  const quick: GateStep[] = [];
  const full: GateStep[] = [];
  const decisions: Decision[] = [];
  const tools = new Map(discovery.tools.map((t) => [t.id, t.evidence]));

  // The best root script per capability (root scripts are what CI and people run).
  const best = (capability: Capability) =>
    discovery.scripts
      .filter((s) => s.dir === ".")
      .flatMap((s) =>
        s.candidates.filter((c) => c.capability === capability).map((c) => ({ script: s.name, c })),
      )
      .sort((a, b) => b.c.confidence - a.c.confidence)[0];

  // A tool configured at the root (its config file is there, not only in a package).
  const configuredAtRoot = (id: string) =>
    (tools.get(id) ?? []).some((e) => !e.includes("/") && !e.includes("#"));
  // The root compiles its own TypeScript (`nest build`, `tsc`), not each package's through a
  // task runner (`turbo build`): only then is the root tsconfig a project to type-check.
  const rootBuild = discovery.scripts.find(
    (s) => s.dir === "." && s.candidates.some((c) => c.capability === "build"),
  );
  const buildsItself =
    rootBuild !== undefined && !commandsOf(rootBuild.command).some((c) => runnerTasks(c) !== undefined);

  for (const capability of ["lint", "typecheck", "test", "e2e"] as const) {
    const found = best(capability);
    // A script that checks one corner (`tsc -p tsconfig.tracker.json`) is no project typecheck.
    const partial = found !== undefined && found.c.confidence < 0.5;
    if ((!found || partial) && capability === "typecheck" && configuredAtRoot("typescript") && buildsItself) {
      // TypeScript without a typecheck script (a build that only transpiles, `nest build`):
      // type errors would pass every gate, so the compiler checks the root project itself.
      full.push(step(capability, { bin: "tsc", args: ["--noEmit", "-p", "tsconfig.json"] }));
      decisions.push({
        capability,
        gate: "full",
        step: "tsc --noEmit -p tsconfig.json",
        evidence: tools.get("typescript") ?? [],
        reason: `TypeScript is configured at the root, the root builds itself (${rootBuild?.name}) and ${
          partial ? `${found.script} type-checks only part of it` : "no script type-checks"
        }`,
      });
      continue;
    }
    if (!found && (capability === "typecheck" || capability === "test")) {
      // A monorepo whose packages type-check or test themselves (`apps/web: typecheck`,
      // `packages/lib: test`) and no root script that runs them: the package manager runs that
      // script in every package.
      // Only workspace packages: the package manager runs nothing across standalone projects.
      const workspace = new Set(discovery.workspaces.map((w) => w.dir));
      const perPackage = discovery.scripts.filter(
        (s) =>
          s.dir !== "." &&
          workspace.has(s.dir) &&
          s.candidates.some((c) => c.capability === capability && c.confidence >= 0.95),
      );
      const count = new Map<string, number>();
      for (const s of perPackage) count.set(s.name, (count.get(s.name) ?? 0) + 1);
      const name = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      if (name) {
        full.push(step(capability, { workspaces: name }));
        decisions.push({
          capability,
          gate: "full",
          step: `workspaces ${name}`,
          evidence: perPackage
            .filter((s) => s.name === name)
            .map((s) => `${s.dir}/package.json#scripts.${name}`),
          reason: `${count.get(name)} package(s) ${capability === "test" ? "test" : "type-check"} with their own ${name} script and no root script runs them`,
        });
      }
      continue;
    }
    if (!found) continue;
    full.push(step(capability, { script: found.script }));
    decisions.push({
      capability,
      gate: "full",
      step: `script ${found.script}`,
      evidence: found.c.evidence,
      reason: `the project's own ${capability} script (confidence ${found.c.confidence})`,
    });

    if (capability !== "lint") continue;
    if (found.c.fileScopable) {
      quick.push(step(capability, { script: found.script }, "append"));
      decisions.push({
        capability,
        gate: "quick",
        step: `script ${found.script} + files`,
        evidence: found.c.evidence,
        reason: "the script can be scoped to the changed files",
      });
      continue;
    }
    // Run on the changed files from the root only when the root configures the tool: with one
    // config per package (no root config), a root `eslint <files>` finds no configuration.
    const tool = FILE_TOOLS[capability]?.find((t) => tools.has(t.tool) && configuredAtRoot(t.tool));
    if (tool) {
      quick.push(step(capability, { bin: tool.bin, args: [...tool.args] }, "append"));
      decisions.push({
        capability,
        gate: "quick",
        step: `${tool.bin} on files`,
        evidence: [...(tools.get(tool.tool) ?? []), ...found.c.evidence],
        reason: `${found.c.reason}; ${tool.tool} runs on the changed files directly`,
      });
    } else {
      // Nothing runs on the changed files alone: the whole lint script, slower but never empty.
      quick.push(step(capability, { script: found.script }));
      decisions.push({
        capability,
        gate: "quick",
        step: `script ${found.script}`,
        evidence: found.c.evidence,
        reason: `${found.c.reason}; no linter configured at the root runs on the changed files alone`,
      });
    }
  }

  // The quick gate checks types and tests as the full gate found them (the end-to-end tests
  // stay in the full one): a quick change (mt-quick) ends at this gate, and a gate with no step
  // stops the run.
  for (const capability of ["typecheck", "test"] as const) {
    const found = full.find((s) => s.id === capability);
    const decided = decisions.find((d) => d.gate === "full" && d.capability === capability);
    if (!found || !decided) continue;
    quick.push(found);
    decisions.push({
      ...decided,
      gate: "quick",
      reason: `the quick gate ${capability === "test" ? "runs the tests" : "checks types"} as the full gate does: a quick change (mt-quick) ends at this gate`,
    });
  }

  // A Java build at the root (round 22): compile, test, and the linters it configures, through
  // its wrapper when there is one. The quick gate builds only the modules of the changed files.
  for (const build of discovery.builds) {
    for (const js of jvmGateSteps(build)) {
      const taken = (id: string) => full.some((s) => s.id === id) || quick.some((s) => s.id === id);
      const id = taken(js.id) ? `${build.tool}:${js.id}` : js.id;
      const run = { build: build.tool, args: [...js.args] };
      // The config names only the tool: the wrapper (or the tool) fitting each machine runs it.
      const program = build.wrapper
        ? `${wrapperOf(build.tool)} ${js.args.join(" ")} (${wrapperOf(build.tool, "win32")} on Windows)`
        : `${buildProgram(build.tool, false)} ${js.args.join(" ")}`;
      full.push({ ...step(id, run), files: "none" });
      quick.push({ ...step(id, run), files: "modules", match: [...JVM_FILES] });
      const evidence = [...js.evidence, ...(build.wrapper ? [build.wrapper] : [])];
      decisions.push(
        { capability: js.id, gate: "full", step: program, evidence, reason: js.reason },
        {
          capability: js.id,
          gate: "quick",
          step: `${program}, only the changed files' modules`,
          evidence,
          reason: `${js.reason}; the quick gate builds only the modules the change touches`,
        },
      );
    }
  }

  if (options.ruleCanon) {
    const rules = step("rules", { metator: "rules check" });
    quick.push(rules);
    full.push(rules);
    decisions.push({
      capability: "rules",
      gate: "quick",
      step: "metator rules check",
      evidence: ["docs/metator/rules"],
      reason: "the repository has a rule canon; its E1 rules run on the changed files",
    });
  }
  return { gates: { quick, full }, decisions };
}
