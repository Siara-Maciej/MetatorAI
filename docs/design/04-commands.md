# Katalog komend CLI `metator`

> Komendy są interfejsem agentów i hooków do faktów o kodzie. Implementacja: use cases i pluginy opisane w [../ARCHITECTURE.md](../ARCHITECTURE.md). Szkice w §5 pokazują pluginy dla stacku Bun, Biome, ast-grep i tsc. Struktura katalogów z §2 jest zastąpiona przez strukturę pakietów z ARCHITECTURE §12.

## 1. Po co skrypty, skoro agent „umie czytać kod”?

| Problem bez skryptów | Co daje skrypt |
|----------------------|----------------|
| Agent w monorepo czyta 30 plików, żeby ustalić zależności, i i tak się myli | `metator graph affected` zwraca dokładną listę w 1 s, w 2 KB JSON |
| „Znajdź podobny moduł” zależy od szczęścia wyszukiwania | `metator similar` zwraca ranking exemplarów z indeksu wzorców (ast-grep) |
| Reguły w promptach są ignorowane pod presją kontekstu | `metator rules check` + reguły ast-grep/Biome dają deterministyczny wynik |
| Review „halucynuje” cytaty i linie | `metator findings check-quote` odrzuca znalezisko z nieistniejącym cytatem |
| Orchestrator „zapomina” o bramce | `metator run advance` odmawia przejścia, hook `Stop` blokuje zakończenie |
| Refactor „nic nie zmienił”, a jednak zmienił API | `metator api diff` porównuje snapshoty `.d.ts` z tsc |
| Nie wiadomo, czy zmiana promptu pomogła | `metator eval compare` pokazuje precision i recall przed i po |

**Zasada podziału:** jeśli odpowiedź da się *policzyć*, liczy ją skrypt. Jeśli wymaga *oceny*, ocenia LLM na podstawie wyniku skryptu.

---

## 2. Architektura `metator`

```
metator/
  cli.ts                     # router: metator <group> <cmd> [args]
  core/
    envelope.ts              # { ok, data, warnings, truncated, next } + exit codes
    workspace.ts             # pakiety z package.json#workspaces, tsconfig per pakiet
    git.ts                   # diff, merge-base, changed files (Bun.$)
    cache.ts                 # .metator/index + hash wejść
    budget.ts                # top-k, limit KB, truncated/next
  index/   graph.ts symbols.ts api.ts patterns.ts cards.ts owners.ts
  rules/   pack.ts check.ts lint.ts adapters.ts coverage.ts
  run/     init.ts advance.ts status.ts checkpoint.ts handoff.ts close.ts
  plan/    lint.ts scope.ts
  findings/ validate.ts quote.ts merge.ts to-github.ts
  gate/    all.ts quick.ts test-affected.ts coverage-diff.ts
  guard/   hook-io.ts pre-tool.ts post-edit.ts subagent-output.ts stop.ts session-start.ts precompact.ts
  memory/  inventory.ts budget.ts dupes.ts validate.ts matrix.ts check.ts
  docs/    inventory.ts drift.ts
  meta/    agents-lint.ts skills-lint.ts workflow-lint.ts audit.ts
  eval/    run.ts score.ts compare.ts
  schemas/ analysis.json research.json plan.json finding.json verdict.json state.json gates.json …
  sg/      rules/*.yml  rule-tests/*.yml  (reguły ast-grep E1 + wykrywanie wzorców)
  fixtures/mini-monorepo/   # do testów bun test
sgconfig.yml                 # ruleDirs: [metator/sg/rules, docs/metator/patterns/sg]; testConfigs
```

### 2.1 Kontrakt wyjścia (wszystkie komendy)

```ts
// metator/core/envelope.ts
export type Envelope<T> = {
  ok: boolean;
  data?: T;
  warnings?: string[];
  truncated?: boolean;      // wynik obcięty do top-k / limitu KB
  next?: string;            // podpowiedź: jak zawęzić zapytanie
  error?: { code: string; message: string; hint?: string };
};

export const EXIT = { OK: 0, FAIL: 1, USAGE: 64, STALE_INDEX: 65 } as const;

export function emit<T>(env: Envelope<T>, maxKb = 8): never {
  let out = JSON.stringify(env);
  if (out.length > maxKb * 1024 && Array.isArray(env.data)) {
    const data = env.data.slice(0, Math.max(1, Math.floor(env.data.length / 2)));
    return emit({ ...env, data: data as T, truncated: true,
      next: env.next ?? "Zawęź zapytanie: --package, --path lub --top" }, maxKb);
  }
  process.stdout.write(out + "\n");
  process.exit(env.ok ? EXIT.OK : EXIT.FAIL);
}
```

Zasady: wyjście zawsze w JSON (dla ludzi flaga `--pretty`), bez kolorów, bez sieci (wyjątki: `findings to-github`, `run init` z ADO przez MCP robi agent, nie skrypt).

### 2.2 Wpięcie w `package.json`

```json
{
  "scripts": {
    "metator": "metator",
    "metator:index": "metator index build",
    "metator:gate": "metator gate all --affected",
    "metator:check": "metator meta check-all",
    "test:metator": "bun test metator"
  }
}
```

---

## 3. Na czym budujemy: Wasz istniejący stack

| Narzędzie | Rola w MetatorAI | Konkretnie |
|-----------|-----------|------------|
| **tsc / TypeScript API** | prawda o typach, modułach i API | `ts.preProcessFile` + `ts.resolveModuleName` budują graf importów (szybko, bez type-checku). `tsc --declaration --emitDeclarationOnly` daje snapshot publicznego API. `tsc -b` / `--noEmit` służy jako bramka typów. `LanguageService.findReferences` daje precyzyjnych callerów na żądanie. |
| **ast-grep** | wzorce strukturalne i reguły E1 | `ast-grep scan --json=stream` wykrywa wystąpienia wzorców (indeks) i łamanie reguł. `ast-grep test` testuje reguły (valid/invalid). Reguły trzymamy w `sgconfig.yml` (`ruleDirs`, `testConfigs`). |
| **Biome** | lint/format, granice importów | `biome check --reporter=json` w bramkach, `--changed --since=<ref>` w CI. `noRestrictedImports` pilnuje granic pakietów, wtyczki **GritQL** (`plugins` z `includes`) obsługują reguły domenowe per ścieżka, `--only`/`--skip` dają szybkie sprawdzenia selektywne. |
| **Bun** | runtime CLI, testy, shell | `Bun.$` (git, ast-grep, biome), `Bun.Glob` (dopasowanie `applyTo`), `bun test` (testy skryptów i projektu), `bun test --coverage --coverage-reporter=lcov` (coverage diff), `--rerun-each` (wykrywanie flaky). |

Z założenia **nie dodajemy** nowych ciężkich narzędzi w F1–F3. Opcjonalnie później: StrykerJS (mutation testing; sprawdzić wsparcie dla `bun test` w F0, fallback: uruchomienie przez command runner), Semgrep (security), dependency-cruiser (jeśli Biome i własny graf nie wystarczą).

---

## 4. Katalog skryptów

Priorytet: **P0** = bez tego workflow nie jest enterprise (F1–F2), **P1** = istotne (F3–F4), **P2** = optymalizacja (F5+).

### A. Indeks wiedzy (T2)

| Komenda | Po co | Wejście → wyjście | Zbudowane na | Używa | Prio |
|---------|-------|-------------------|--------------|-------|------|
| `index build [--check]` | buduje cały T2 z cache po hashu | repo → `.metator/index/*` | wszystkie poniżej | CI nightly, `session-start` | P0 |
| `graph deps <pkg\|file>` | zależności wychodzące | → lista krawędzi | TS API | scout, planner | P0 |
| `graph affected [--diff base] [--files …]` | co dotyka zmiana: pliki, pakiety, testy | diff → `{files, packages, tests, owners}` | graf + git | scout, gate, CI review | P0 |
| `graph callers <symbol\|file> [--precise]` | kto używa (reachability dla review) | → top-k callerów z `file:line` | graf + ast-grep (fast) / LanguageService (precise) | review-*, verifier | P0 |
| `graph path <a> <b>` | jak moduł A zależy od B | → najkrótsza ścieżka | graf | contracts, scout | P1 |
| `graph cycles` | cykle importów | → lista cykli | graf (cross-check z Biome `noImportCycles`) | gate, nightly | P1 |
| `graph diff [--base]` | nowe i usunięte krawędzie vs baza, łamanie dozwolonych zależności z kart | → `{added, removed, violations}` | graf × 2 | gate (refactor, feature) | P0 |
| `symbols find <name\|--kind>` | reuse check: czy coś już istnieje | → top-k symboli eksportowanych | TS API | implementer, planner | P0 |
| `api snapshot <pkg>` / `api diff <pkg>` | publiczne API przed i po | `.d.ts` → diff znormalizowany | tsc emitDeclarationOnly | refactor, contracts | P0 |
| `patterns scan [--check]` | indeks wzorców: wystąpienia, exemplar, legacy | reguły `docs/metator/patterns/sg` → `patterns.json` | ast-grep scan | pattern-miner, nightly | P0 |
| `similar <opis\|plik\|symbol> [--top 3]` | „pokaż jak to już robimy” | → exemplary z uzasadnieniem dopasowania | patterns.json + symbole + nazwy | pattern-miner, planner | P0 |
| `cards build [--check]` | generowana część kart modułów | graf+api+patterns+CODEOWNERS → `*.card.md` | wszystkie | nightly | P1 |
| `owners <path>` | właściciel (do eskalacji i review) | CODEOWNERS → team | parser | scout, pr-author | P2 |

### B. Reguły

| Komenda | Po co | Prio |
|---------|-------|------|
| `rules pack --paths <…> [--from-run]` | rule pack: tylko reguły pasujące do ścieżek (`Bun.Glob`), ID + 1 zdanie + exemplar | P0 |
| `rules check --files <…>` | uruchamia reguły E1: `ast-grep scan` + `biome lint --only=…` i mapuje wyniki na `MT-*` | P0 |
| `rules lint` | walidacja canon: schemat, unikalne ID, linki, exemplary, E1 ma implementację i test | P0 |
| `rules adapters [--check]` | generuje `.github/instructions/mt-*.instructions.md` z canon | P0 |
| `rules coverage` | % reguł E1, reguły bez testów, reguły nigdy nieodpalone (z telemetrii) | P1 |
| `rules scaffold-sg <MT-ID>` | szkielet reguły ast-grep + pliku testu dla `mt-docs-curator` | P1 |
| `adr lint` | numeracja, status, sekcja „Implikacje dla kodu” z istniejącymi ID | P1 |

### C. Workflow i stan (T3)

| Komenda | Po co | Prio |
|---------|-------|------|
| `run init --workflow <id> --input <…>` | tworzy run, `state.json` ze spec, waliduje wejście i preconditions | P0 |
| `run advance <stage> [--result pass\|fail]` | przejście maszyny stanów: kolejność, artefakty, schematy, limity pętli | P0 |
| `run status [--run id]` | wznowienie: etap, brakujące artefakty, ostatnie wpisy logu | P0 |
| `run approve <gate> --by user --choice N` | zapis zgody HITL (warunek dla hooków push i komentarzy) | P0 |
| `run checkpoint` | streszczenie stanu do `log.md` (PreCompact) | P1 |
| `run handoff` / `run close` | dokument przekazania, archiwizacja, telemetria końcowa | P1 |
| `plan lint` | plan: schemat, każdy `create` ma `pattern_source` istniejący w indeksie, testy przed implementacją, kolejność wg grafu, brak plików spoza zakresu zadania, nowe abstrakcje → `adr_required` | P0 |
| `plan scope` | z `plan.json` generuje `plan-scope.json` (globy edycji) + shardy niezależne (brak krawędzi w grafie) | P0 |
| `workflow lint` | spec YAML vs anatomia (16 sekcji), istniejący agenci i skille, limity | P1 |

### D. Review i znaleziska

| Komenda | Po co | Prio |
|---------|-------|------|
| `findings validate <dir>` | schemat `finding@1`, blocking wymaga `trigger` + `reachability` + `evidence` | P0 |
| `findings check-quote <file>` | cytat istnieje w `file` w okolicy `line` (normalizacja białych znaków) | P0 |
| `findings merge <dir>` | deduplikacja (file + symbol + hash przyczyny), łączenie soczewek | P0 |
| `findings to-github --format natural\|labeled` | mapowanie na komentarze inline/body (publikacja przez MCP po approval) | P1 |
| `review shard --diff` | podział diffu na shardy wg pakietów, ≤ ~800 linii | P0 |

### E. Bramki jakości

| Komenda | Po co | Prio |
|---------|-------|------|
| `gate quick --files <…>` | szybka: `biome check` + `ast-grep scan` na plikach + `tsc --noEmit` pakietu | P0 |
| `gate all [--affected]` | pełna: biome, tsc -b, rules check, `test affected`, `graph diff`, `api diff` (jeśli refactor), coverage diff → `gates.json` | P0 |
| `test affected` | testy dotknięte zmianą (graf odwrotny → pliki `*.test.ts`) → `bun test <files>` | P0 |
| `coverage diff` | lcov przed/po dla dotkniętych plików, pokrycie nowych linii | P1 |
| `flaky check <test> --runs 5` | determinizm testu (`bun test --rerun-each`) | P1 |
| `debug-tags check` | brak pozostawionych `[DEBUG-xxxx]` | P2 |

### F. Hooki (guard)

| Komenda | Zdarzenie | Logika | Prio |
|---------|-----------|--------|------|
| `guard session-start` | SessionStart | czy index świeży (jeśli nie: ostrzeżenie + `next`), aktywny run → kontekst `run status` | P1 |
| `guard pre-tool` | PreToolUse | edycja poza `plan-scope` → deny, push/komentarz bez approval → deny, odczyt sekretów → deny, rola koordynatora edytuje kod → deny | P0 |
| `guard post-edit` | PostToolUse | `biome check --write` na pliku + `ast-grep scan` pliku → wynik jako kontekst | P0 |
| `guard subagent-output` | SubagentStop | artefakt workera zgodny ze schematem, inaczej komunikat do ponowienia | P0 |
| `guard precompact` | PreCompact | `run checkpoint` | P1 |
| `guard stop` | Stop | nieterminalny etap bez artefaktu bramki → blokada z listą braków | P0 |

### G. Pamięć

| Komenda | Po co | Prio |
|---------|-------|------|
| `memory inventory` | spis nośników wiedzy (audyt, krok 1 mapy) | P0 |
| `memory budget` | rozmiary vs budżety z `memory-map.yml` | P0 |
| `memory dupes` | duplikaty i konflikty reguł w różnych plikach | P1 |
| `memory validate [--fix]` | cytaty `[[cite: …]]` w kartach, lessons, canon: istnieją? przesunięte? stale? | P0 |
| `memory matrix` | macierz agent × pamięć z mapy (dokumentacja + dane dla hooka) | P2 |
| `memory check` | strażnik CI: każdy plik wiedzy w mapie, budżety, adaptery aktualne | P0 |
| `lessons add` | dodanie lekcji z cytatem (używane przez mt-retro po HITL) | P1 |

### H. Dokumentacja

| Komenda | Po co | Prio |
|---------|-------|------|
| `docs inventory` | lista dokumentów, wiek, właściciel, linki | P1 |
| `docs drift` | twierdzenia z `claims.verified.json` sprawdzane ponownie (cytaty, symbole, ścieżki) → raport driftu | P1 |
| `docs links` | martwe linki w docs, ADR i instrukcjach | P2 |

### I. Meta i evale

| Komenda | Po co | Prio |
|---------|-------|------|
| `meta agents-lint` | prefiks z `naming.agentPrefix` (domyślnie `mt-`), frontmatter, `user-invocable`, allowlista `agents` wskazuje istniejących, długości, link do spec, dozwolone nazwy tooli | P0 |
| `meta skills-lint` | name = katalog, description z trigger/anty-trigger, ≤ 300 linii, skrypty istnieją | P0 |
| `meta audit` | inwentarz agentów i skilli + graf wywołań + karta zgodności (F0) | P0 |
| `meta check-all` | wszystkie lint/check jednym poleceniem (pre-commit, CI) | P0 |
| `eval run [--affected] [--repeat 3]` | uruchamia przypadki ze złotego zbioru (headless Copilot CLI z `--agent`) | P1 |
| `eval score` / `eval compare --base main` | precision, recall, stabilność, koszt i regresja vs baseline | P1 |

---

## 5. Szkice kluczowych implementacji

### 5.1 Graf importów (tsc API, bez type-checku)

```ts
// metator/index/graph.ts
import ts from "typescript";
import { Glob } from "bun";
import { workspacePackages, compilerOptionsFor } from "../core/workspace";

export type Edge = { from: string; to: string; kind: "internal" | "cross-package" | "external" };

export async function buildGraph(root: string) {
  const edges: Edge[] = [];
  for (const pkg of await workspacePackages(root)) {
    const options = compilerOptionsFor(pkg);               // parsuje tsconfig pakietu
    for await (const file of new Glob("src/**/*.{ts,tsx}").scan({ cwd: pkg.dir, absolute: true })) {
      const text = await Bun.file(file).text();
      const { importedFiles } = ts.preProcessFile(text, true, true);
      for (const imp of importedFiles) {
        const res = ts.resolveModuleName(imp.fileName, file, options, ts.sys).resolvedModule;
        if (!res || res.isExternalLibraryImport) {
          edges.push({ from: file, to: imp.fileName, kind: "external" });
          continue;
        }
        const target = res.resolvedFileName;
        edges.push({ from: file, to: target, kind: target.startsWith(pkg.dir) ? "internal" : "cross-package" });
      }
    }
  }
  return edges;                                            // zapis: .metator/index/graph.json (+ hash wejść)
}
```

`graph affected` = zmienione pliki (`git diff --name-only <merge-base>`) → domknięcie po krawędziach odwrotnych → pakiety + pliki `*.test.ts` w domknięciu.

### 5.2 Wykrywanie wzorców (ast-grep)

```yaml
# docs/metator/patterns/sg/mt-pattern-query-hook.yml   (przykład: wzorzec hooka zapytania)
id: mt-pattern-query-hook
language: TypeScript
severity: info
message: "pattern:query-hook"
rule:
  all:
    - kind: export_statement
    - has:
        stopBy: end
        pattern: useQuery($$$ARGS)
```

```ts
// metator/index/patterns.ts
const out = await Bun.$`ast-grep scan --config sgconfig.yml --filter '^mt-pattern-' --json=stream`.quiet().text();
const hits = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
// hits[i]: { ruleId, file, range: { start: { line } }, text, ... }
// → grupowanie po ruleId, liczba wystąpień per pakiet, exemplar = najnowszy plik spoza listy legacy
```

### 5.3 Reguła E1 z testem (ast-grep)

```yaml
# metator/sg/rules/mt-arch-no-deep-import.yml
id: mt-arch-no-deep-import
language: TypeScript
severity: error
message: "MT-ARCH-003: importuj pakiet przez publiczny entry, nie przez src/"
rule:
  pattern: import $$$IMPORTS from $SRC
constraints:
  SRC:
    regex: "^['\"]@acme/[^/]+/src/"
```

```yaml
# metator/sg/rule-tests/mt-arch-no-deep-import-test.yml
id: mt-arch-no-deep-import
valid:
  - import { Invoice } from "@acme/billing";
invalid:
  - import { Invoice } from "@acme/billing/src/invoice";
```

```yaml
# sgconfig.yml
ruleDirs: [metator/sg/rules, docs/metator/patterns/sg]
testConfigs:
  - testDir: metator/sg/rule-tests
```

CI: `ast-grep test` (reguły mają testy) i `ast-grep scan` (kod łamie reguły?).

### 5.4 Reguły w Biome (granice i reguły domenowe per ścieżka)

```json
{
  "linter": {
    "rules": {
      "style": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "paths": {
              "lodash": "MT-TS-012: używaj @acme/core/collections"
            }
          }
        }
      }
    }
  },
  "plugins": [
    { "path": "./metator/biome/mt-dom-no-raw-date.grit", "includes": ["packages/*/src/domain/**"] }
  ]
}
```

```grit
// metator/biome/mt-dom-no-raw-date.grit
`new Date($args)` where {
  register_diagnostic(span=$args, message="MT-DOM-004: w domenie używaj Clock z @acme/core/time")
}
```

Podział: **Biome** dla reguł, które mają dawać feedback w edytorze i w `post-edit` (importy, proste wzorce). **ast-grep** dla reguł strukturalnych z testami, wykrywania wzorców i reguł złożonych (relacje `inside`/`has`).

### 5.5 Hook `pre-tool` z adapterem formatu

```ts
// metator/guard/hook-io.ts: jedyne miejsce zależne od formatu I/O hooków (weryfikacja w F0)
export type HookInput = { tool: string; input: Record<string, unknown>; cwd: string };

export async function readHookInput(): Promise<HookInput> {
  const raw = JSON.parse(await Bun.stdin.text());
  return {
    tool: raw.tool_name ?? raw.toolName ?? "",
    input: raw.tool_input ?? raw.toolInput ?? {},
    cwd: raw.cwd ?? process.cwd(),
  };
}

export function decide(decision: "allow" | "deny" | "ask", reason: string): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);                       // nie polegamy na exit code 2
}
```

```ts
// metator/guard/pre-tool.ts
import { readHookInput, decide } from "./hook-io";
import { activeRun } from "../run/state";
import { Glob } from "bun";

const { tool, input } = await readHookInput();
const run = await activeRun();                       // brak runu → tryb swobodny
const path = String(input.filePath ?? input.file_path ?? input.path ?? "");
const command = String(input.command ?? "");

if (/(^|\/)\.env|\.pem$|id_rsa/.test(path)) decide("deny", "MT-SEC-001: odczyt sekretów zablokowany.");
if (!run) decide("allow", "no active run");

if (/^(edit|write|create|apply_patch)/i.test(tool) && path) {
  if (run.role === "coordinator") decide("deny", "Koordynator nie edytuje plików. Deleguj do mt-implementer.");
  const ok = run.permissions.edit_scope.some((g: string) => new Glob(g).match(path));
  if (!ok) decide("deny", `Plik ${path} spoza plan-scope. Zaktualizuj plan (mt-planner) albo zapytaj użytkownika.`);
}
if (/git\s+push|gh\s+pr\s+(create|merge)/.test(command) && !run.approvals.push)
  decide("deny", "Push wymaga zgody (G8). Pokaż raport i opcje użytkownikowi, potem `metator run approve G8`.");

decide("allow", "ok");
```

### 5.6 Walidacja znalezisk i cytatów

```ts
// metator/findings/quote.ts
export async function quoteExists(file: string, line: number, quote: string, window = 10) {
  const lines = (await Bun.file(file).text()).split("\n");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const q = norm(quote);
  for (let i = Math.max(0, line - 1 - window); i < Math.min(lines.length, line + window); i++) {
    const chunk = norm(lines.slice(i, i + q.split(" ").length + 3).join(" "));
    if (chunk.includes(q)) return { ok: true, actualLine: i + 1 };
  }
  return { ok: false };
}
```

`findings validate` odrzuca `severity: blocking` bez `trigger`, `reachability` i `evidence`, a każde znalezisko z nieistniejącym cytatem degraduje do `invalid` (nie trafia do Verify).

### 5.7 Rule pack

```ts
// metator/rules/pack.ts (szkic)
const rules = await loadRules("docs/metator/rules");        // parsuje bloki "### MT-…" + pola
const pack = rules.filter((r) => r.status !== "deprecated" &&
  paths.some((p) => r.applyTo.some((g) => new Glob(g).match(p))));
// wyjście: posortowane po enforcement (E2 najpierw, bo E1 i tak sprawdzi skrypt), max ~2k tokenów
```

---

## 6. Gdzie skrypty są wywoływane

| Miejsce | Skrypty |
|---------|---------|
| **Hooki** (`.github/hooks/mt-guards.json`) | `guard *` |
| **Skille** (`scripts/*.sh` jako wrappery) | `similar`, `rules pack`, `graph *`, `plan lint`, `findings *`, `api *` |
| **Workerzy** (przez `execute`, tylko komendy `metator`) | jak wyżej + `gate *` (gatekeeper) |
| **Koordynatorzy** | tylko `run *` |
| **Pre-commit** (opcjonalnie lefthook/husky) | `meta check-all`, `rules adapters --check`, `memory budget` |
| **CI (PR)** | `meta check-all`, `memory check`, `ast-grep test`, `gate all --affected`, (W12) `eval run --affected` |
| **CI (nightly)** | `index build`, `cards build`, `patterns scan`, `memory validate`, `docs drift`, `rules coverage` |
| **Copilot coding agent** (`copilot-setup-steps.yml`) | `bun install`, `metator index build` |

---

## 7. Jakość samych skryptów

- `bun test metator` na fixture'ze mini-monorepo (3 pakiety, celowe naruszenia, wzorce, legacy).
- Testy snapshotowe wyjść JSON. Zmiana kontraktu = nowa `schemaVersion` + migracja (ADR-0016).
- Pomiar czasu: `pre-tool` < 300 ms, `post-edit` < 5 s, `graph affected` < 2 s na ciepłym cache. Benchmark w CI.
- Biome i tsc obowiązują też `metator`, bez wyjątków.
