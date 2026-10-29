# ADR-0003: Formaty wymiany: SARIF, JUnit XML, LCOV

- Status: Accepted
- Data: 2026-10-25
- Źródło: [ARCHITECTURE.md §9.4](../ARCHITECTURE.md)

## Kontekst
Każde narzędzie raportuje inaczej. Pisanie parsera per narzędzie nie skaluje się.

## Decyzja
Domena zna trzy typy: `Diagnostic`/`DiagnosticReport`, `TestReport`, `CoverageReport`. Pluginy wybierają najbogatszy dostępny format, preferując standardy: **SARIF** (diagnostyki), **JUnit XML** (testy), **LCOV** (coverage). Natywne JSON-y (Biome, ESLint, ast-grep) i tekst tsc mają własne parsery. `exit-code` to ostateczny fallback.

## Konsekwencje
### Pozytywne
- Jeden parser obsługuje wiele narzędzi.
- Dodanie narzędzia to zwykle preset (komenda + parser), bez nowego kodu.

### Negatywne
- Niektóre formaty gubią szczegóły (np. kolumny, fix-y).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Parser per narzędzie | nie skaluje się, duplikacja |

## Implikacje dla kodu
ADR-0003 egzekwują reguły kanonu MT-CODE-001, MT-ARCH-005 (`metator rules show <id>`).
