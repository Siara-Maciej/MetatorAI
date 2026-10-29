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
