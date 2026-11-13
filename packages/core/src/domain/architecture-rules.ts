import { type ArchContext, importsPackage, pairKey } from "./architecture-context.ts";
import { declaredIn, ROOT_PACKAGE } from "./architecture-manifests.ts";
import { overThresholds } from "./architecture-metrics.ts";
import { moduleViolations } from "./architecture-modules.ts";
import {
  type ArchSeverity,
  brokenTagRules,
  DEFAULT_SEVERITY,
  type ViolationKind,
} from "./architecture-policy.ts";
import type { ArchEdge, Violation } from "./architecture-report.ts";

/** One rule of the analysis: what is wrong in a context, in the order it finds it. */
export type ArchRule = (ctx: ArchContext) => Violation[];

/** A violation at its kind's default severity (the policy's severities and exceptions come later). */
function violation(
  kind: ViolationKind,
  subject: string,
  message: string,
  pkgs: readonly string[],
  evidence: readonly Violation["evidence"][number][] = [],
  severity: ArchSeverity = DEFAULT_SEVERITY[kind],
): Violation {
  return {
    id: `${kind}:${subject}`,
    kind,
    severity,
    message,
    packages: [...pkgs],
    evidence: evidence.slice(0, 5),
  };
}

const samplesOf = (e: ArchEdge) => e.samples.map((s) => ({ file: s.from, to: s.to }));
const byName = (a: string, b: string) => a.localeCompare(b);
/** `express` → `@types/express`, `@scope/pkg` → `@types/scope__pkg`. */
const typesOf = (name: string) => `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;

/** Packages that depend on each other. */
const cycles: ArchRule = (ctx) =>
  ctx.cycles.map((c) =>
    violation(
      "cycle",
      c.packages.join(","),
      `${c.packages.join(" ⇄ ")} depend on each other${c.typeOnly ? " (only through import type)" : ""}`,
      c.packages,
      c.edges.flatMap((ce) => {
        const e = ctx.edges.find((x) => x.from === ce.from && x.to === ce.to);
        return e ? samplesOf(e).slice(0, 1) : [];
      }),
      // A cycle only `import type` closes costs type checking, not runtime: a warning by default.
      c.typeOnly ? "warning" : undefined,
    ),
  );

/** What is wrong with an edge between two packages: how it is written, declared, and what it reaches. */
const edges: ArchRule = (ctx) => {
  const out: Violation[] = [];
  for (const e of ctx.edges) {
    if (e.from === ROOT_PACKAGE) continue;
    const relative = ctx.relativeOf(e);
    if (relative.length > 0)
      out.push(
        violation(
          "relative-import",
          `${e.from}→${e.to}`,
          `${e.from} reaches into ${e.to} with a relative path instead of its package name`,
          [e.from, e.to],
          relative,
        ),
      );
    if (e.to === ROOT_PACKAGE) continue;
    if (e.declared === "none")
      out.push(
        violation(
          "undeclared",
          `${e.from}→${e.to}`,
          `${e.from} imports the workspace package ${e.to} without declaring it in package.json`,
          [e.from, e.to],
          samplesOf(e),
        ),
      );
    else if (e.declared === "devDependencies" && !e.testOnly)
      out.push(
        violation(
          "dev-in-prod",
          `${e.from}→${e.to}`,
          `${e.from} imports ${e.to} outside tests, but declares it only in devDependencies`,
          [e.from, e.to],
          samplesOf(e),
        ),
      );
    if (!e.testOnly && ctx.pkg.get(e.to)?.kind === "app")
      out.push(
        violation(
          "app-import",
          `${e.from}→${e.to}`,
          `${e.from} depends on the application ${e.to}; applications sit on top and nothing imports them`,
          [e.from, e.to],
          samplesOf(e),
        ),
      );
  }
  return out;
};

/** External packages: declared where they are imported. */
const externals: ArchRule = (ctx) => {
  const { input, byPackage, pkgOf, devOnly } = ctx;
  const imported = new Map<string, { files: string[]; prod: boolean; runtimeProd: boolean }>();
  for (const x of input.externals) {
    if (!importsPackage(ctx, x)) continue;
    const p = pkgOf(x.from);
    if (p === ROOT_PACKAGE || byPackage.has(x.name)) continue;
    const key = pairKey(p, x.name);
    const entry = imported.get(key) ?? { files: [], prod: false, runtimeProd: false };
    if (entry.files.length < 5) entry.files.push(x.from);
    if (!devOnly(x.from)) {
      entry.prod = true;
      if (!x.typeOnly) entry.runtimeProd = true;
    }
    imported.set(key, entry);
  }
  const out: Violation[] = [];
  for (const [key, x] of [...imported.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [p, name] = key.split("\u0000") as [string, string];
    const field = declaredIn(byPackage.get(p), name);
    const evidence = x.files.map((file) => ({ file, specifier: name }));
    // `import { Request } from "express"` with @types/express declared: the types are what is
    // used (TypeScript drops the import), as in a NestJS app on top of @nestjs/platform-express.
    if (field === undefined && declaredIn(byPackage.get(p), typesOf(name)) !== undefined) continue;
    if (field === undefined) {
      if (declaredIn(input.manifests.root, name) !== undefined)
        out.push(
          violation(
            "root-only",
            `${p}→${name}`,
            `${p} imports ${name}, declared only by the repository root (works through hoisting)`,
            [p],
            evidence,
          ),
        );
      else
        out.push(
          violation(
            "undeclared",
            `${p}→${name}`,
            `${p} imports ${name} without declaring it in package.json`,
            [p],
            evidence,
          ),
        );
    } else if (field === "devDependencies" && x.runtimeProd)
      out.push(
        violation(
          "dev-in-prod",
          `${p}→${name}`,
          `${p} imports ${name} outside tests, but declares it only in devDependencies`,
          [p],
          evidence,
        ),
      );
  }
  return out;
};

/** Declared dependencies nothing imports (scripts and @types count as uses). */
const unusedDependencies: ArchRule = (ctx) => {
  const out: Violation[] = [];
  for (const m of ctx.input.manifests.packages) {
    if (m.dir === ".") continue;
    const imported = ctx.used.get(m.name) ?? new Set<string>();
    const scripts = Object.values(m.scripts).join("\n");
    for (const name of Object.keys(m.dependencies).sort()) {
      if (imported.has(name) || name.startsWith("@types/") || scripts.includes(name)) continue;
      out.push(
        violation(
          "unused-dependency",
          `${m.name}→${name}`,
          `${m.name} declares ${name} in dependencies, but no file imports it`,
          [m.name],
          [{ file: `${m.dir}/package.json`, specifier: name }],
        ),
      );
    }
  }
  return out;
};

/** One dependency, several version ranges. */
const versionDrift: ArchRule = (ctx) => {
  const { input, byPackage } = ctx;
  const ranges = new Map<string, Map<string, string[]>>();
  for (const m of [...(input.manifests.root ? [input.manifests.root] : []), ...input.manifests.packages]) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      for (const [name, range] of Object.entries(m[field])) {
        if (/^(workspace|link|file|portal|catalog):/.test(range) || byPackage.has(name)) continue;
        const forName = ranges.get(name) ?? new Map<string, string[]>();
        forName.set(range, [...new Set([...(forName.get(range) ?? []), m.name])]);
        ranges.set(name, forName);
      }
    }
  }
  const out: Violation[] = [];
  for (const [name, byRange] of [...ranges.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (byRange.size < 2) continue;
    const list = [...byRange.entries()].sort(([a], [b]) => a.localeCompare(b));
    out.push(
      violation(
        "version-drift",
        name,
        `${name} is declared with ${list.length} ranges: ${list.map(([r, ps]) => `${r} (${ps.join(", ")})`).join("; ")}`,
        [...new Set(list.flatMap(([, ps]) => ps))].sort(byName),
        list.flatMap(([r, ps]) =>
          ps.map((p) => ({
            file: `${byPackage.get(p)?.dir ?? "."}/package.json`,
            specifier: `${name}@${r}`,
          })),
        ),
      ),
    );
  }
  return out;
};

/** Layers and tag rules, then the packages no layer holds. */
const layersAndTags: ArchRule = (ctx) => {
  const { policy, pkg } = ctx;
  const layerIndex = (name: string) => {
    const layer = pkg.get(name)?.layer;
    return layer === undefined ? undefined : policy.layers.findIndex((l) => l.name === layer);
  };
  const out: Violation[] = [];
  for (const e of ctx.production) {
    if (e.from === ROOT_PACKAGE || e.to === ROOT_PACKAGE) continue;
    const a = layerIndex(e.from);
    const b = layerIndex(e.to);
    if (a !== undefined && b !== undefined && b < a)
      out.push(
        violation(
          "layer",
          `${e.from}→${e.to}`,
          `${e.from} (layer ${policy.layers[a]?.name}) depends on ${e.to} (layer ${policy.layers[b]?.name}, above it)`,
          [e.from, e.to],
          samplesOf(e),
        ),
      );
    const broken = brokenTagRules(policy, pkg.get(e.from)?.tags ?? [], pkg.get(e.to)?.tags ?? []);
    if (broken.length > 0)
      out.push(
        violation(
          "tag",
          `${e.from}→${e.to}`,
          `${e.from} → ${e.to}: ${broken.join("; ")}`,
          [e.from, e.to],
          samplesOf(e),
        ),
      );
  }
  if (policy.layers.length > 0)
    for (const p of ctx.packages)
      if (p.kind !== "root" && p.layer === undefined)
        out.push(
          violation(
            "unlayered",
            p.name,
            `${p.name} belongs to no layer, so its dependencies are not checked`,
            [p.name],
          ),
        );
  return out;
};

/** Metrics over the policy's thresholds, package by package. */
const thresholds: ArchRule = (ctx) =>
  ctx.workspace.flatMap((p) => {
    const metrics = ctx.metrics.get(p.name);
    if (!metrics) return [];
    return overThresholds(ctx.policy.thresholds, {
      distance: metrics.distance,
      fanOut: metrics.ce,
      fanIn: metrics.ca,
      files: p.files - p.testFiles,
      depth: metrics.depth,
    }).map((t) =>
      violation(
        "threshold",
        `${p.name}:${t.metric}`,
        `${p.name}: ${t.metric} ${t.value} is over the threshold ${t.limit}`,
        [p.name],
      ),
    );
  });

/** Modules inside packages: cycles, and imports past a module's public part. */
const modules: ArchRule = (ctx) =>
  (ctx.inner ? moduleViolations(ctx.inner) : []).map((v) =>
    // A cycle only `import type` closes is a warning, as between packages.
    violation(v.kind, v.subject, v.message, v.modules, v.evidence, v.typeOnly ? "warning" : undefined),
  );

/**
 * The rules, in the order their violations are raised. The report sorts violations by severity
 * and id afterwards; the order here still decides between two violations with one id.
 */
export const ARCH_RULES: readonly ArchRule[] = [
  cycles,
  edges,
  externals,
  unusedDependencies,
  versionDrift,
  layersAndTags,
  thresholds,
  modules,
];
