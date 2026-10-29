# ADR-0041: Kroki MetatorAI w bramkach, `MetatorConfig` v2 i `coverage diff`

- Status: Accepted
- Data: 2026-10-26

## Kontekst
`gate all` (04-commands §E) ma obejmować `rules check`, `test affected`, `graph diff`, `api diff` (refactor) i `coverage diff`. `MetatorConfig` v1 dopuszczał w kroku `metator` tylko `rules check` (`z.enum`). Brakowało `coverage diff`: pokrycia linii dodanych przez zmianę.

## Decyzja
- **`MetatorConfig` v2:** krok `{ metator: … }` przyjmuje `rules check`, `test affected`, `graph diff`, `api diff <pakiet>` i `coverage diff [--min <proc>] [--lcov <plik>]` (`parseMetatorStep`). Migracja v1 → v2 to tożsamość, bo każdy plik v1 jest poprawnym v2. Schemat v1 jest zamrożony i niezmieniony, a przykład v1 dowodzi migracji (MT-CODE-003).
- **`GateChecks`** (zamiast `CheckRules` w `RunGate`) mapuje raport każdego sprawdzenia na pass/fail ze szczegółem:
  - `rules check` nie przechodzi przy błędach;
  - `test affected` nie przechodzi przy czerwonym runie;
  - `graph diff` nie przechodzi przy nowym cyklu, a nowe zależności pakietów tylko zgłasza;
  - `api diff` nie przechodzi przy każdej zmianie;
  - `coverage diff` nie przechodzi poniżej `--min`.
  Pliki albo `--base` bramki zawężają sprawdzenia, które da się zawęzić. `gate all` to alias `gate full`.
- **`coverage diff [--base] [--lcov] [--min]`:**
  - dodane linie: `RevisionReader.addedLines`, czyli `git diff -U0` od merge base sparsowany przez `parse-diff`, plus nieśledzone pliki w całości;
  - pokrycie: port `CoverageReader`, czyli `LcovCoverageReader` na `@friedemannsommer/lcov-parser`. LCOV piszą bun, vitest, jest i c8, więc MetatorAI nie zna runnera;
  - liczą się tylko linie instrumentowane, testy nie są mierzonym kodem, a dodane pliki kodu, których żaden test nie załadował, są wypisane osobno (`unmeasured`).
- **`flaky check <test> [--runs] [--script]`** uruchamia jeden plik testów N razy skryptem testów repo. Wynik mieszany oznacza test niestabilny; wynik zawsze czerwony jest deterministyczny.
- Dogfood: bramka `full` MetatorAI dostaje krok `graph diff`.

## Konsekwencje
### Pozytywne
- Jedna bramka sprawdza wszystko, co etap G6 workflowu wymaga, z jedną konfiguracją.
- Nowe linie bez testów są widoczne w bramce, a nie dopiero w review.
### Negatywne
- `coverage diff` czyta raport, który repo musi wcześniej wygenerować (krok `script` przed krokiem `metator`).
- Runner decyduje, co jest linią instrumentowaną (bun liczy deklaracje na poziomie modułu jako pokryte).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Nowy enum w v1 | zmiana wydanej wersji w miejscu (MT-CODE-003) |
| Własny parser LCOV i diffu | dwa gotowe, utrzymywane pakiety (ADR-0010) |
| `coverage diff` uruchamiający testy sam | musiałby znać flagi pokrycia każdego runnera |

## Implikacje dla kodu
ADR-0041 egzekwują reguły kanonu MT-CODE-003, MT-CODE-002 (`metator rules show <id>`).
