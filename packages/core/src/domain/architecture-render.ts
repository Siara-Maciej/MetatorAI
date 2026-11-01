import type { ArchitectureReport, Violation } from "./architecture.ts";

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const list = (items: readonly string[]) => (items.length === 0 ? "—" : items.join(", "));

function violationLines(violations: readonly Violation[]): string[] {
  const lines: string[] = [];
  for (const v of violations) {
    const where = v.evidence
      .slice(0, 3)
      .map((e) => `\`${e.file}\`${e.to ? ` → \`${e.to}\`` : ""}${e.specifier ? ` (\`${e.specifier}\`)` : ""}`)
      .join("; ");
    lines.push(`- **${v.kind}** ${cell(v.message)}${where ? ` — ${where}` : ""} <sub>\`${v.id}\`</sub>`);
    if (v.exception)
      lines.push(`  - excepted until ${v.exception.expires} by ${v.exception.owner}: ${v.exception.reason}`);
  }
  return lines;
}

/** `report.md`: the report for people, in the order they act on it. */
export function renderArchitectureMarkdown(report: ArchitectureReport): string {
  const s = report.summary;
  const active = report.violations.filter((v) => !v.exception);
  const out: string[] = [
    "# Architecture report",
    "",
    `Policy: ${report.policy ? `\`${report.policy}\`` : "defaults (no `metator/architecture.yml`)"}`,
    "",
    "| Score | Packages | Apps | Dependencies | Cycles | Errors | Warnings | Excepted |",
    "|------:|---------:|-----:|-------------:|-------:|-------:|---------:|---------:|",
    `| ${s.score} | ${s.packages} | ${s.apps} | ${s.edges} | ${s.cycles} | ${s.errors} | ${s.warnings} | ${s.excepted} |`,
    "",
  ];

  out.push("## Cycles", "");
  if (report.cycles.length === 0) out.push("No package depends on itself through others.", "");
  for (const c of report.cycles) {
    out.push(`### ${c.packages.join(" ⇄ ")}${c.typeOnly ? " (type-only)" : ""}`, "");
    out.push("| From | To | Imports | Runtime |", "|------|----|--------:|--------:|");
    for (const e of c.edges) out.push(`| ${e.from} | ${e.to} | ${e.imports} | ${e.runtime} |`);
    if (c.cut && c.cut.length > 0)
      out.push(
        "",
        `Cheapest cut: ${c.cut.map((e) => `${e.from} → ${e.to} (${e.imports} imports)`).join(", ")}.`,
      );
    out.push("");
  }

  out.push("## Violations", "");
  if (active.length === 0) out.push("None.", "");
  for (const severity of ["error", "warning"] as const) {
    const group = active.filter((v) => v.severity === severity);
    if (group.length === 0) continue;
    out.push(
      `### ${severity === "error" ? "Errors" : "Warnings"} (${group.length})`,
      "",
      ...violationLines(group),
      "",
    );
  }
  const excepted = report.violations.filter((v) => v.exception);
  if (excepted.length > 0) out.push(`### Excepted (${excepted.length})`, "", ...violationLines(excepted), "");

  out.push("## Packages", "");
  const metrics = report.packages.some((p) => p.metrics);
  out.push(
    `| Package | Kind | Layer | Files | Depends on | Dependents${metrics ? " | I | A | D | Depth" : ""} |`,
    `|---------|------|-------|------:|------------|-----------${metrics ? "|--:|--:|--:|------:" : ""}|`,
  );
  for (const p of report.packages) {
    const m = p.metrics;
    const tail = metrics
      ? m
        ? ` | ${m.instability.toFixed(2)} | ${m.abstractness.toFixed(2)} | ${m.distance.toFixed(2)} | ${m.depth}`
        : " | | | |"
      : "";
    out.push(
      `| ${p.name} | ${p.kind} | ${p.layer ?? "—"} | ${p.files} | ${list(p.dependsOn)} | ${list(p.dependents)}${tail} |`,
    );
  }
  out.push("");

  const mods = report.modules;
  if (mods) {
    out.push(
      "## Modules",
      "",
      `${mods.modules.length} modules in ${mods.globs.join(", ")}${mods.public ? `; public part: ${mods.public.join(", ")}` : ""}.`,
      "",
    );
    if (mods.twoWay.length > 0)
      out.push(
        `Import each other (${mods.twoWay.length}): ${mods.twoWay.map(([a, z]) => `${a} ⇄ ${z}`).join(", ")}.`,
        "",
      );
    for (const c of mods.cycles)
      out.push(`- Cycle of ${c.modules.length}${c.typeOnly ? " (type-only)" : ""}: ${list(c.modules)}`);
    if (mods.cycles.length > 0) out.push("");
    out.push("| Module | Files | Depends on | Dependents |", "|--------|------:|------------|------------|");
    for (const m of mods.modules)
      out.push(`| ${m.name} | ${m.files} | ${list(m.dependsOn)} | ${list(m.dependents)} |`);
    out.push("");
  }

  const b = report.boundaries;
  if (b) {
    out.push("## Boundaries", "");
    for (const s of b.split)
      out.push(
        `- **Split ${s.package}?** ${s.clusters.length} groups of files with different users: ${s.clusters
          .map((c) => `${c.files} files (${c.sample.slice(0, 2).join(", ")}…) used by ${list(c.consumers)}`)
          .join("; ")}`,
      );
    for (const m of b.merge) out.push(`- **Merge ${m.package} into ${m.into}?** ${m.reason}`);
    for (const h of b.hubs)
      out.push(`- **Hub ${h.package}:** ${h.fanIn} dependents, ${h.fanOut} dependencies`);
    if (b.deadPackages.length > 0) out.push(`- **Nothing depends on:** ${b.deadPackages.join(", ")}`);
    if (b.deadExports.length > 0)
      out.push(
        `- **Exports nothing imports (${b.deadExports.length}):** ${b.deadExports
          .slice(0, 20)
          .map((d) => `\`${d.name}\` (${d.file})`)
          .join(", ")}${b.deadExports.length > 20 ? ", …" : ""}`,
      );
    out.push("");
  }
  if (report.coupling && report.coupling.length > 0) {
    out.push(
      "## Changed together",
      "",
      "| A | B | Commits | Ratio | Dependency |",
      "|---|---|--------:|------:|------------|",
    );
    for (const c of report.coupling)
      out.push(`| ${c.a} | ${c.b} | ${c.together} | ${c.ratio.toFixed(2)} | ${c.dependency} |`);
    out.push("");
  }
  if (report.teams) {
    out.push("## Teams", "");
    for (const e of report.teams.edges) out.push(`- ${e.from} → ${e.to}: ${e.imports} imports`);
    if (report.teams.unowned.length > 0) out.push(`- No owner: ${report.teams.unowned.join(", ")}`);
    out.push("");
  }
  if (report.apps) {
    out.push("## Applications", "");
    for (const a of report.apps.closure)
      out.push(`- **${a.app}** pulls ${a.packages.length}: ${list(a.packages)}`);
    const wide = report.apps.blastRadius.filter((r) => r.apps.length > 1).slice(0, 10);
    if (wide.length > 0)
      out.push(
        "",
        "Widest blast radius:",
        ...wide.map((r) => `- ${r.package} reaches ${r.apps.length}: ${list(r.apps)}`),
      );
    out.push("");
  }

  out.push("## Limits", "");
  out.push(
    report.unresolved.count === 0
      ? "Every import resolved."
      : `${report.unresolved.count} imports did not resolve and are not in this report, e.g. ${report.unresolved.sample
          .slice(0, 5)
          .map((u) => `\`${u.specifier}\` in ${u.from}`)
          .join(", ")}.`,
    "",
  );
  return out.join("\n");
}

const esc = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The package graph as SVG: one row per depth (applications on top), cycles and broken rules in color. */
export function renderPackageSvg(report: ArchitectureReport): string {
  const nodes = report.packages.filter((p) => p.kind !== "root");
  const depth = (name: string) => nodes.find((p) => p.name === name)?.metrics?.depth ?? 0;
  const max = Math.max(0, ...nodes.map((p) => depth(p.name)));
  // One band per depth, applications on top; a band wider than PER_ROW wraps onto more lines.
  const PER_ROW = 6;
  const bands = new Map<number, string[]>();
  for (const p of nodes) bands.set(depth(p.name), [...(bands.get(depth(p.name)) ?? []), p.name]);
  const lines_: string[][] = [];
  for (let d = max; d >= 0; d--) {
    const names = (bands.get(d) ?? []).sort();
    for (let i = 0; i < names.length; i += PER_ROW) lines_.push(names.slice(i, i + PER_ROW));
  }
  const W = 180;
  const H = 36;
  const GAP_X = 24;
  const GAP_Y = 56;
  const widest = Math.max(1, ...lines_.map((r) => r.length));
  const width = widest * (W + GAP_X) + GAP_X;
  const height = Math.max(1, lines_.length) * (H + GAP_Y) + GAP_Y / 2;
  const at = new Map<string, { x: number; y: number }>();
  lines_.forEach((names, row) => {
    const offset = (width - names.length * (W + GAP_X) + GAP_X) / 2;
    names.forEach((n, i) => {
      at.set(n, { x: offset + i * (W + GAP_X), y: GAP_Y / 2 + row * (H + GAP_Y) });
    });
  });
  const inCycle = new Set(report.cycles.flatMap((c) => c.edges.map((e) => `${e.from}\u0000${e.to}`)));
  const broken = new Set(
    report.violations
      .filter((v) => !v.exception && ["layer", "tag", "app-import"].includes(v.kind))
      .map((v) => `${v.packages[0]}\u0000${v.packages[1]}`),
  );
  const lines = report.edges
    .filter((e) => !e.testOnly && at.has(e.from) && at.has(e.to))
    .map((e) => {
      const a = at.get(e.from) as { x: number; y: number };
      const b = at.get(e.to) as { x: number; y: number };
      const key = `${e.from}\u0000${e.to}`;
      const cls = inCycle.has(key) ? "cycle" : broken.has(key) ? "broken" : "edge";
      const down = b.y >= a.y;
      return `<line class="${cls}" x1="${a.x + W / 2}" y1="${down ? a.y + H : a.y}" x2="${b.x + W / 2}" y2="${down ? b.y : b.y + H}" marker-end="url(#arrow-${cls})"><title>${esc(`${e.from} → ${e.to}: ${e.imports} imports`)}</title></line>`;
    });
  const boxes = nodes.map((p) => {
    const { x, y } = at.get(p.name) as { x: number; y: number };
    const label = p.name.length > 24 ? `${p.name.slice(0, 23)}…` : p.name;
    return `<g class="node ${p.kind}"><rect x="${x}" y="${y}" width="${W}" height="${H}" rx="6"/><text x="${x + W / 2}" y="${y + H / 2 + 4}">${esc(label)}</text><title>${esc(`${p.name} (${p.kind}${p.layer ? `, layer ${p.layer}` : ""}): ${p.files} files`)}</title></g>`;
  });
  const marker = (id: string) =>
    `<marker id="arrow-${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="${id}" d="M0,0 L10,5 L0,10 z"/></marker>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;min-width:${Math.min(width, 720)}px" role="img" aria-label="Package graph"><defs>${["edge", "cycle", "broken"].map(marker).join("")}</defs>${lines.join("")}${boxes.join("")}</svg>`;
}

/** `report.html`: one self-contained page (no scripts, no network) to read and share. */
export function renderArchitectureHtml(report: ArchitectureReport): string {
  const s = report.summary;
  const active = report.violations.filter((v) => !v.exception);
  const table = (head: readonly string[], rows: readonly (readonly string[])[]) =>
    rows.length === 0
      ? '<p class="muted">None.</p>'
      : `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`;
  const tile = (label: string, value: string | number, cls = "") =>
    `<div class="tile ${cls}"><div class="value">${esc(String(value))}</div><div class="label">${esc(label)}</div></div>`;
  const b = report.boundaries;
  const sections = [
    `<h2>Package graph</h2><div class="graph">${renderPackageSvg(report)}</div><p class="muted">Rows by depth, applications on top. <span class="key cycle">cycle</span> <span class="key broken">layer, tag or application rule</span></p>`,
    `<h2>Violations</h2>${table(
      ["Severity", "Kind", "Message", "Where", "Id"],
      active.map((v) => [v.severity, v.kind, v.message, v.evidence[0]?.file ?? "", v.id]),
    )}`,
    `<h2>Cycles</h2>${table(
      ["Packages", "Type-only", "Cheapest cut"],
      report.cycles.map((c) => [
        c.packages.join(" ⇄ "),
        c.typeOnly ? "yes" : "no",
        (c.cut ?? []).map((e) => `${e.from} → ${e.to} (${e.imports})`).join(", "),
      ]),
    )}`,
    `<h2>Packages</h2>${table(
      ["Package", "Kind", "Layer", "Files", "Ca", "Ce", "I", "A", "D", "Depth", "Exports used outside"],
      report.packages
        .filter((p) => p.kind !== "root")
        .map((p) => [
          p.name,
          p.kind,
          p.layer ?? "",
          String(p.files),
          String(p.metrics?.ca ?? ""),
          String(p.metrics?.ce ?? ""),
          p.metrics ? p.metrics.instability.toFixed(2) : "",
          p.metrics ? p.metrics.abstractness.toFixed(2) : "",
          p.metrics ? p.metrics.distance.toFixed(2) : "",
          String(p.metrics?.depth ?? ""),
          p.metrics?.exportsUsed == null ? "" : `${Math.round(p.metrics.exportsUsed * 100)}%`,
        ]),
    )}`,
    ...(b
      ? [
          `<h2>Boundaries</h2>${table(
            ["Candidate", "Package", "Why"],
            [
              ...b.split.map((x) => [
                "split",
                x.package,
                x.clusters.map((c) => `${c.files} files used by ${c.consumers.join(", ")}`).join("; "),
              ]),
              ...b.merge.map((x) => ["merge", x.package, `into ${x.into}: ${x.reason}`]),
              ...b.hubs.map((x) => ["hub", x.package, `${x.fanIn} dependents, ${x.fanOut} dependencies`]),
              ...b.deadPackages.map((x) => ["unused package", x, "nothing depends on it"]),
            ],
          )}<p class="muted">${b.deadExports.length} exported symbol(s) nothing imports.</p>`,
        ]
      : []),
    ...(report.coupling
      ? [
          `<h2>Changed together</h2>${table(
            ["A", "B", "Commits", "Ratio", "Dependency"],
            report.coupling.map((c) => [c.a, c.b, String(c.together), c.ratio.toFixed(2), c.dependency]),
          )}`,
        ]
      : []),
    ...(report.teams
      ? [
          `<h2>Teams</h2>${table(
            ["From", "To", "Imports"],
            report.teams.edges.map((e) => [e.from, e.to, String(e.imports)]),
          )}`,
        ]
      : []),
    ...(report.apps
      ? [
          `<h2>Applications</h2>${table(
            ["Package", "Applications it reaches"],
            report.apps.blastRadius.map((r) => [r.package, r.apps.join(", ")]),
          )}`,
        ]
      : []),
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Architecture report</title>
<style>
:root{--bg:#fff;--fg:#1c1e21;--muted:#65676b;--line:#d0d4da;--card:#f5f6f8;--accent:#3b6fd4;--bad:#d4443b;--warn:#d48a1e}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e4e6eb;--muted:#a0a4ab;--line:#3a3d43;--card:#202329;--accent:#7aa2ff;--bad:#ff6b61;--warn:#f0a83a}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto}h1{margin:0 0 4px}h2{margin:32px 0 8px}.muted{color:var(--muted)}
.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}.tile{background:var(--card);border-radius:8px;padding:12px 16px;min-width:110px}
.tile .value{font-size:24px;font-weight:600}.tile .label{color:var(--muted)}.tile.bad .value{color:var(--bad)}.tile.warn .value{color:var(--warn)}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.graph{background:var(--card);border-radius:8px;padding:8px;overflow-x:auto}
svg .node rect{fill:var(--bg);stroke:var(--accent);stroke-width:1.5}svg .node.app rect{stroke-width:3}
svg text{fill:var(--fg);font-size:12px;text-anchor:middle}svg line{stroke-width:1.5}
svg .edge{stroke:var(--line);fill:var(--line)}svg .cycle{stroke:var(--bad);fill:var(--bad)}svg .broken{stroke:var(--warn);fill:var(--warn)}
.key{padding:0 6px;border-radius:4px;color:var(--bg)}.key.cycle{background:var(--bad)}.key.broken{background:var(--warn)}
</style></head><body><main>
<h1>Architecture report</h1><p class="muted">Policy: ${esc(report.policy ?? "defaults (no metator/architecture.yml)")}</p>
<div class="tiles">${tile("score", s.score)}${tile("packages", s.packages)}${tile("applications", s.apps)}${tile("cycles", s.cycles, s.cycles > 0 ? "bad" : "")}${tile("errors", s.errors, s.errors > 0 ? "bad" : "")}${tile("warnings", s.warnings, s.warnings > 0 ? "warn" : "")}${tile("excepted", s.excepted)}</div>
${sections.join("\n")}
<p class="muted">${report.unresolved.count} unresolved import(s) are not in this report.</p>
</main></body></html>
`;
}
