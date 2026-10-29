# ADR-0025: Biome jako silnik E1 przez SARIF

- Status: Accepted
- Data: 2026-10-26

## Kontekst
Wiele reguł projektu da się wyrazić regułą Biome (np. `useImportType`, `noRestrictedImports`), które repozytoria już konfigurują. Bez adaptera `rules lint` tylko ostrzega, że implementacja `biome:…` nie jest zweryfikowana, a `rules check` nie mapuje znalezisk Biome na ID kanonu. Reporter `json` Biome jest eksperymentalny i może się zmieniać w wersjach patch.

## Decyzja
- **Mapowanie SARIF 2.1.0** w domenie core (`diagnosticsFromSarif`): ścieżki bezwzględne i `file://` zamieniane na ścieżki względem repo, poziomy `error/warning/note` na `Severity`, wyniki posortowane. To format wymiany z ADR-0003; ten sam kod obsłuży ESLint, Semgrep i CodeQL.
- **`BiomeEngine`** (`packages/plugin-biome`, port `RuleEngine`):
  - reguły `lint/<grupa>/<reguła>` z `configuration_schema.json` zainstalowanego Biome; liczą się jako przetestowane, bo Biome testuje własne reguły;
  - znaleziska z `biome lint --reporter=sarif --max-diagnostics=none --files-ignore-unknown=true --no-errors-on-unmatched`;
  - binarka z `node_modules/.bin` repozytorium ma pierwszeństwo;
  - repo bez `biome.json`/`biome.jsonc` jest pomijane, żeby nie raportować domyślnych reguł, których nikt nie wybrał.
- Dogfood: MT-CODE-006 (`import type`) i MT-CODE-007 (protokół `node:`) jako E1 przez Biome.

## Konsekwencje
### Pozytywne
- Reguła z kanonu może wskazać regułę Biome, a lint sprawdza, czy taka reguła istnieje w zainstalowanej wersji.
- Jeden parser SARIF dla kolejnych narzędzi.
### Negatywne
- `rules lint` nie sprawdza jeszcze, czy reguła Biome jest **włączona** w konfiguracji; wyłączona reguła E1 byłaby fałszywą obietnicą.
- Lista reguł zależy od układu schematu konfiguracji Biome; zmiana schematu wymaga aktualizacji adaptera (testy adaptera to wyłapią).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Reporter `json` Biome | eksperymentalny, może się zmienić w wersji patch |
| `@biomejs/js-api` | API do formatowania/lintowania treści, bez konfiguracji projektu i ignorów VCS |
| Uruchamianie Biome zawsze | w repo bez Biome raportuje reguły, których nikt nie wybrał |

## Implikacje dla kodu
ADR-0025 egzekwują reguły kanonu MT-CODE-001, MT-CODE-005 (`metator rules show <id>`).
