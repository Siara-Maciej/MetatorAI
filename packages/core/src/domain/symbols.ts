/**
 * Symbol-level facts (`symbols find`, `graph callers`, ADR-0040): which file defines an exported
 * name, and which files import it, also through re-exports (barrels, renames, `export *`).
 */

/** What one module exports and imports, by name; specifiers are not resolved yet. */
export interface ModuleSymbols {
  /** Names the module declares and exports itself (including `export { local }`). */
  readonly exports: readonly { readonly name: string; readonly line: number; readonly typeOnly: boolean }[];
  /** `export { a as b } from "./x"` (imported a, exported b), `export * from "./x"` (both "*"). */
  readonly reexports: readonly {
    readonly specifier: string;
    readonly imported: string;
    readonly exported: string;
    readonly line: number;
  }[];
  /** `import { a as b }` (imported a), `import d` ("default"), `import * as ns` ("*"). */
  readonly imports: readonly {
    readonly specifier: string;
    readonly imported: string;
    readonly local: string;
    readonly line: number;
    readonly typeOnly: boolean;
  }[];
}

/** A module with its specifiers resolved to repo files (unresolved or external ones dropped). */
export interface ResolvedModule {
  readonly exports: ModuleSymbols["exports"];
  readonly reexports: readonly (ModuleSymbols["reexports"][number] & { readonly target: string })[];
  readonly imports: readonly (ModuleSymbols["imports"][number] & { readonly target: string })[];
}

export interface SymbolDefinition {
  readonly file: string;
  readonly line: number;
  readonly typeOnly: boolean;
}

export function findSymbol(name: string, modules: ReadonlyMap<string, ResolvedModule>): SymbolDefinition[] {
  const out: SymbolDefinition[] = [];
  for (const [file, m] of modules)
    for (const e of m.exports) if (e.name === name) out.push({ file, line: e.line, typeOnly: e.typeOnly });
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export interface SymbolCaller {
  readonly file: string;
  readonly line: number;
  /** The name it is bound to in the caller (`ns` for a namespace import). */
  readonly local: string;
  /** The module it was imported from: the definition or a re-exporting barrel. */
  readonly via: string;
  readonly namespace: boolean;
}

/**
 * Every import of `name` defined in `file`: directly, or from any module that re-exports it
 * (under any name). A namespace import of a providing module counts as a caller.
 */
export function callersOf(
  name: string,
  file: string,
  modules: ReadonlyMap<string, ResolvedModule>,
): {
  readonly callers: SymbolCaller[];
  readonly providers: { readonly file: string; readonly name: string }[];
} {
  const providers = new Map<string, Set<string>>([[file, new Set([name])]]);
  const provides = (f: string, n: string) => providers.get(f)?.has(n) ?? false;
  let grew = true;
  while (grew) {
    grew = false;
    for (const [f, m] of modules) {
      for (const r of m.reexports) {
        const names = providers.get(r.target);
        if (!names) continue;
        for (const n of names) {
          const passes = r.imported === "*" ? n !== "default" : r.imported === n;
          // `export * as ns from` exposes a namespace, not the name itself.
          const exported = r.imported === "*" ? (r.exported === "*" ? n : undefined) : r.exported;
          if (!passes || exported === undefined || provides(f, exported)) continue;
          providers.set(f, new Set([...(providers.get(f) ?? []), exported]));
          grew = true;
        }
      }
    }
  }

  const callers: SymbolCaller[] = [];
  for (const [f, m] of modules) {
    for (const i of m.imports) {
      const names = providers.get(i.target);
      if (!names) continue;
      if (i.imported === "*")
        callers.push({ file: f, line: i.line, local: i.local, via: i.target, namespace: true });
      else if (names.has(i.imported))
        callers.push({ file: f, line: i.line, local: i.local, via: i.target, namespace: false });
    }
  }
  return {
    callers: callers.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    providers: [...providers]
      .flatMap(([f, names]) => [...names].map((n) => ({ file: f, name: n })))
      .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)),
  };
}
