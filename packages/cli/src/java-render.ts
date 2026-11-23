import type {
  JavaBean,
  JavaConfigKey,
  JavaConfigRead,
  JavaDataRepository,
  JavaEndpoint,
  JavaEntity,
  JavaEntrypoint,
  JavaIndexReport,
  JavaModule,
  JavaOverview,
  JavaPersistenceUnitFact,
  JavaShow,
  JavaTypeLine,
} from "@metator/core";

/**
 * The `metator java` commands as a person reads them at a terminal (ADR-0107): one line per fact,
 * with its `path:line`. The JSON envelope carries the same data, whole.
 */

function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const r of rows)
    for (let i = 0; i < r.length; i++) widths[i] = Math.max(widths[i] ?? 0, (r[i] as string).length);
  return rows
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  "))
    .join("\n");
}

const short = (name: string) => name.replace(/^(?:[a-z_$][\w$]*\.)+(?=[A-Z])/g, "");

export function renderJavaOverview(o: JavaOverview): string {
  const lines = [
    `Java · ${o.buildTools.join(", ") || "no build file"}, ${o.modules.length} module${o.modules.length === 1 ? "" : "s"}`,
    `Java ${[...new Set(o.javaVersions.map((v) => v.version))].join(", ") || "version not declared"}`,
    `${o.counts.files} files, ${o.counts.types} types, ${o.counts.endpoints} endpoints, ${o.counts.entities} entities, ${o.counts.repositories} repositories, ${o.counts.beans} beans, ${o.counts.configKeys} config keys, ${o.counts.entrypoints} entry points`,
  ];
  if (o.frameworks.length > 0)
    lines.push(`Frameworks: ${o.frameworks.map((f) => `${f.name} (${f.count})`).join(", ")}`);
  lines.push(
    "",
    "Modules:",
    table(o.modules.map((m) => [m.name, m.dir, m.profile ? `profile ${m.profile}` : ""])),
  );
  if (o.parseFailures.length > 0) {
    lines.push("", `Could not fully parse ${o.parseFailures.length} file(s); the rest was read:`);
    for (const f of o.parseFailures) lines.push(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.message}`);
  }
  return lines.join("\n");
}

export function renderJavaModules(v: {
  readonly modules: readonly (JavaModule & {
    readonly dependsOn: readonly string[];
    readonly external: readonly { coordinate: string; scope: string }[];
  })[];
}): string {
  if (v.modules.length === 0) return "No Maven or Gradle build here.";
  return v.modules
    .map((m) =>
      [
        `${m.name}  ${m.dir}  ${m.build}${m.packaging ? ` ${m.packaging}` : ""}${m.profile ? `  (profile ${m.profile})` : ""}${m.javaVersion ? `  Java ${m.javaVersion.version}` : ""}`,
        ...(m.dependsOn.length > 0 ? [`  depends on ${m.dependsOn.join(", ")}`] : []),
        ...m.external.map((d) => `  ${d.coordinate} (${d.scope})`),
      ].join("\n"),
    )
    .join("\n");
}

export function renderJavaTypes(v: { readonly types: readonly JavaTypeLine[] }): string {
  if (v.types.length === 0) return "No types match.";
  return table(
    v.types.map((t) => [
      t.kind,
      t.name,
      t.annotations.map((a) => `@${a}`).join(" "),
      `${t.at}${t.test ? " (test)" : ""}${t.generated ? " (generated)" : ""}`,
    ]),
  );
}

export function renderJavaShow(s: JavaShow): string {
  const t = s.type;
  const ann = (as: readonly { name: string }[]) => as.map((a) => `@${a.name} `).join("");
  const lines = [
    `${ann(t.annotations)}${[...t.modifiers, t.kind].join(" ")} ${t.qualifiedName}${t.typeParameters.length > 0 ? `<${t.typeParameters.join(", ")}>` : ""}`,
    `  ${t.at}  module ${t.module || "-"}${t.test ? "  test" : ""}${t.generated ? "  generated" : ""}`,
  ];
  if (t.extends.length > 0) lines.push(`  extends ${t.extends.join(", ")}`);
  if (t.implements.length > 0) lines.push(`  implements ${t.implements.join(", ")}`);
  if (s.roles.length > 0) lines.push(`  roles: ${s.roles.join(", ")}`);
  for (const c of t.enumConstants) lines.push(`  ${c}`);
  for (const f of t.fields)
    lines.push(`  ${ann(f.annotations)}${[...f.modifiers, f.type].join(" ")} ${f.name}  :${f.line}`);
  for (const c of t.constructors)
    lines.push(
      `  ${ann(c.annotations)}${t.name}(${c.parameters.map((p) => `${p.type} ${p.name}`).join(", ")})  :${c.line}`,
    );
  for (const m of t.methods)
    lines.push(
      `  ${ann(m.annotations)}${[...m.modifiers, m.returnType].join(" ")} ${m.name}(${m.parameters.map((p) => `${ann(p.annotations)}${p.type} ${p.name}`).join(", ")})  :${m.line}`,
    );
  if (s.subtypes.length > 0) lines.push("", "Subtypes:", ...s.subtypes.map((x) => `  ${x.name}  ${x.at}`));
  if (s.usedBy.length > 0)
    lines.push("", `Used by ${s.usedBy.length} file(s):`, ...s.usedBy.map((u) => `  ${u.file}`));
  return lines.join("\n");
}

export function renderJavaEndpoints(v: { readonly endpoints: readonly JavaEndpoint[] }): string {
  if (v.endpoints.length === 0) return "No endpoints found.";
  return table(
    v.endpoints.map((e) => [
      e.method,
      e.path,
      `${short(e.handler)}${e.responseType ? ` → ${short(e.responseType)}` : ""}`,
      `${e.framework}${e.confidence === "likely" ? " (likely)" : ""}`,
      e.at,
    ]),
  );
}

export function renderJavaEntities(v: {
  readonly entities: readonly JavaEntity[];
  readonly persistenceUnits: readonly JavaPersistenceUnitFact[];
}): string {
  if (v.entities.length === 0 && v.persistenceUnits.length === 0) return "No JPA entities found.";
  const lines: string[] = [];
  for (const e of v.entities) {
    lines.push(
      `${e.type}  ${e.kind}${e.table ? `  table ${e.table}` : ""}${e.inheritance ? `  ${e.inheritance}` : ""}  ${e.at}`,
    );
    for (const r of e.relations)
      lines.push(
        `  ${r.field}: ${r.kind} → ${short(r.target)}${r.mappedBy ? ` (mappedBy ${r.mappedBy})` : ""}${r.joinColumn ? ` (join ${r.joinColumn})` : ""}`,
      );
  }
  for (const u of v.persistenceUnits)
    lines.push(`persistence unit ${u.name}: ${u.classes.join(", ")}  ${u.at}`);
  return lines.join("\n");
}

export function renderJavaRepositories(v: { readonly repositories: readonly JavaDataRepository[] }): string {
  if (v.repositories.length === 0) return "No Spring Data repositories found.";
  return v.repositories
    .map((r) =>
      [
        `${r.type}  ${r.base}<${short(r.entity ?? "?")}, ${short(r.id ?? "?")}>  ${r.at}`,
        ...r.methods.map((m) => `  ${m.name}  ${m.kind}${m.query ? `  ${m.query}` : ""}`),
      ].join("\n"),
    )
    .join("\n");
}

export function renderJavaBeans(v: { readonly beans: readonly JavaBean[] }): string {
  if (v.beans.length === 0) return "No beans found.";
  return v.beans
    .map((b) =>
      [
        `${b.name}  ${short(b.type)}  @${b.stereotype}${b.scope ? ` ${b.scope}` : ""}  ${b.at}`,
        ...b.injections.map(
          (i) =>
            `  ← ${i.via} ${i.name}: ${short(i.type)} ${i.provider ? `= ${i.provider}` : `(${i.candidates} candidates)`}${i.confidence === "likely" ? " (likely)" : ""}`,
        ),
      ].join("\n"),
    )
    .join("\n");
}

export function renderJavaConfig(v: {
  readonly keys: readonly JavaConfigKey[];
  readonly reads: readonly JavaConfigRead[];
}): string {
  if (v.keys.length === 0 && v.reads.length === 0) return "No configuration keys found.";
  const lines = v.keys.map((k) => `${k.key} = ${k.value}${k.profile ? `  [${k.profile}]` : ""}  ${k.at}`);
  if (v.reads.length > 0) {
    lines.push("", "Read by:");
    for (const r of v.reads)
      lines.push(
        `  ${r.key}  ${r.via} ${short(r.type)}.${r.member}${r.default !== undefined ? ` (default ${r.default})` : ""}${r.defined ? "" : "  (not defined)"}  ${r.at}`,
      );
  }
  return lines.join("\n");
}

export function renderJavaEntrypoints(v: { readonly entrypoints: readonly JavaEntrypoint[] }): string {
  if (v.entrypoints.length === 0) return "No entry points found.";
  return table(v.entrypoints.map((e) => [e.kind, short(e.handler), e.detail ?? "", e.at]));
}

export function renderJavaIndex(r: JavaIndexReport): string {
  return `${r.path}: ${r.files} files, ${r.parsed} parsed, ${r.reused} reused, ${r.failed} with syntax errors (${r.ms} ms)`;
}
