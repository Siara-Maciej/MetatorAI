import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { defineLoader } from "vitepress";
import { parse } from "yaml";

/**
 * The shipped workflow specs (.github/metator/workflows/*.yml), read at build time so the diagrams
 * on the site always show the stages, owners, gates and loops the CLI actually runs.
 */
export interface StageView {
  id: string;
  description?: string;
  owners: string[];
  parallel: string[];
  produces: string[];
  hitl: boolean;
  neverSkip: boolean;
  skipAt: string[];
  gate?: { script?: string; llm?: string };
  onFail?: { goto: string; loop: string; limit: number };
  optional: boolean;
}

export interface WorkflowView {
  id: string;
  description?: string;
  autonomy: string[];
  done: string[];
  stages: StageView[];
}

declare const data: Record<string, WorkflowView>;

export { data };

const list = (v: unknown): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)];

/** The spec fields the site reads; `workflow lint` validates the rest. */
interface RawStage {
  id: string;
  description?: string;
  owner?: unknown;
  parallel?: unknown;
  produces?: unknown;
  hitl?: boolean;
  neverSkip?: boolean;
  skipAt?: unknown;
  gate?: StageView["gate"];
  onFail?: { goto: string; loop: string };
  optional?: boolean;
}
interface RawSpec {
  kind?: string;
  id: string;
  description: string;
  autonomy?: unknown;
  done?: unknown;
  loops?: Record<string, number>;
  stages: RawStage[];
}

export default defineLoader({
  watch: ["../../../.github/metator/workflows/*.yml"],
  load(files: string[]): Record<string, WorkflowView> {
    const out: Record<string, WorkflowView> = {};
    for (const file of files.sort()) {
      const spec = parse(readFileSync(file, "utf8")) as RawSpec;
      if (spec?.kind !== "Workflow") throw new Error(`${basename(file)} is not a Workflow document`);
      const loops = spec.loops ?? {};
      out[spec.id] = {
        id: spec.id,
        description: spec.description,
        autonomy: list(spec.autonomy),
        done: list(spec.done),
        stages: spec.stages.map((s) => ({
          id: s.id,
          ...(s.description ? { description: s.description } : {}),
          owners: list(s.owner),
          parallel: list(s.parallel),
          produces: list(s.produces),
          hitl: s.hitl === true,
          neverSkip: s.neverSkip === true,
          skipAt: list(s.skipAt),
          ...(s.gate ? { gate: s.gate } : {}),
          ...(s.onFail ? { onFail: { ...s.onFail, limit: loops[s.onFail.loop] ?? 0 } } : {}),
          optional: s.optional === true,
        })),
      };
    }
    return out;
  },
});
