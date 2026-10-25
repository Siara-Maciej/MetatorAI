# ADR-0020: Kanon reguł jako wersjonowany YAML, adaptery hostów i silniki E1

- Status: Proposed
- Data: 2026-10-25

## Kontekst
Reguły muszą mieć niezmienne ID, poziom egzekucji (E1/E2/E3), zakres (`applyTo`), uzasadnienie i źródło z datą weryfikacji ([zasady §3](../design/01-principles.md#3-reguły-canon-docsmetatorrulesareamd)). Agent ma dostawać tylko reguły pasujące do plików, które zmienia, a instrukcje hostów (Copilot `applyTo`) nie mogą być ręcznie utrzymywaną kopią. Szablon w [templates §4](../design/05-templates.md#4-reguła) zakładał bloki Markdown z polami w punktach, co wymaga własnego parsera Markdown.

## Decyzja
- **Kanon:** jeden dokument `RuleSet` (YAML, `kind` + `schemaVersion`, ADR-0016) na obszar w `docs/metator/rules/<area>.yml`, walidowany schematem zod. JSON Schema: `metator rules schema`. Wersja Markdown dla ludzi i hostów jest generowana.
- **Poziomy egzekucji:** E1 rozstrzyga narzędzie (`implementation: <engine>:<rule id>`, z testem), E2 da się sprawdzić w review na podstawie diffu (konkretne `do`/`dont`), E3 wymaga osądu.
- **Komendy:**
  - `rules lint`: schemat, unikalne ID, jeden prefiks, obszar w ID, linki do plików i kotwic Markdown, referencje między regułami, implementacja E1 z testem w silniku, martwe `applyTo` (ostrzeżenie).
  - `rules pack`: reguły aktywne dla ścieżek, najpierw E2, potem E3; E1 jako jedna linia; budżet tokenów, a pominięte reguły są wymienione z ID.
  - `rules show`, `rules check` (silniki E1, mapowanie `toolRuleId → canonRuleId`).
  - `rules adapters [--check]`: jeden plik `.github/instructions/<prefix>-<area>.instructions.md` na obszar (wersjonowany `InstructionsAdapter`); `--check` w CI wykrywa ręczne edycje i dryf.
- **Silnik ast-grep** (`plugin-astgrep`, port `RuleEngine`): reguły z `sgconfig.yml` (`ruleDirs`, testy z `testConfigs`), wyniki z `ast-grep scan --json=stream` przez port `ProcessRunner`. Pierwszeństwo ma binarka repozytorium (`node_modules/.bin/ast-grep`). Wyniki są sortowane, bo ast-grep skanuje równolegle.
- **Kotwice Markdown:** `github-slugger`, ten sam algorytm co GitHub. Dodany do listy dozwolonych zależności `@metator/core` (czysty, bez I/O).

## Konsekwencje
### Pozytywne
- Brak własnego parsera Markdown: jedno źródło (YAML + zod), z którego powstają pack, instrukcje hostów i JSON Schema.
- Dryf instrukcji i martwe linki są czerwone w CI (`bun run canon`).
### Negatywne
- Odejście od szablonu Markdown z dokumentów projektowych; trzeba zaktualizować [templates §4](../design/05-templates.md#4-reguła).
- Biome i tsc jako silniki E1 jeszcze nie mają adapterów: `rules lint` ostrzega, że implementacja nie jest zweryfikowana.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Bloki Markdown `### MT-…` z polami w punktach | wymaga własnego parsera i własnej walidacji, błędy bez ścieżki pola |
| remark/mdast do parsowania Markdown | ciężka zależność dla danych, które i tak są strukturalne |
| `@ast-grep/napi` zamiast CLI | nie obsługuje `sgconfig.yml` (ruleDirs, testy); CLI to kanoniczny interfejs narzędzia |
| Ręcznie pisane `.instructions.md` | kopia kanonu, która się rozjeżdża |
