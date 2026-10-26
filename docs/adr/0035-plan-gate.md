# ADR-0035: Bramka planu: `plan lint` i `plan scope`

- Status: Proposed
- Data: 2026-10-26

## Kontekst
Bramka G4 (workflows, 04-commands §C) ma odrzucać plany, zanim powstanie kod. Dotąd plan był tylko tekstem dla `mt-plan-critic`, więc o tym, czy nowy plik ma exemplar, czy testy są przed implementacją i czy kolejność zgadza się z grafem importów, decydował osąd modelu. Hooki F4 (`pre-tool`) potrzebują do tego zakresu edycji w formie, którą da się sprawdzić.

## Decyzja
- **Dokument `Plan`** (`plan.json` w katalogu runu, `defineDocument`): `task`, `scope` (globy zadania) i `steps`. Krok ma pola `id`, `action` (`create|modify|delete`), `path`, `intent`, `skill`, `patternSource {pattern, exemplar, reason}` albo `newPatternAdr`, `rules`, `testsFirst` i `dependsOn`. Pola są w camelCase jak w pozostałych dokumentach; szkic z 05-templates §9 używał snake_case.
- **`plan lint`** (czysta funkcja `lintPlan` w domenie, fakty z repo w use case `LintPlan`):
  - unikalne id, znane zależności, brak cykli;
  - każdy plik i test w `scope`;
  - `create` tylko dla nieistniejących plików, `modify|delete` tylko dla istniejących albo tworzonych w planie;
  - tworzony plik kodu ma `patternSource`, którego exemplar jest wystąpieniem wzorca w indeksie (`patterns scan`), albo `newPatternAdr` (wtedy krok trafia do `adrRequired`);
  - zmiana kodu ma `testsFirst`: pliki testów pisane przez krok, od którego zależy (przechodnio);
  - kolejność według grafu: krok, którego plik importuje plik innego kroku, idzie po nim. Testy są wyjątkiem, bo importują testowany kod, a powstają przed nim;
  - usunięty plik nie może zostawić importujących, których plan nie zmienia;
  - reguły kanonu w `rules` istnieją.
- **`plan scope`** zapisuje dokument `PlanScope` (`plan-scope.json`): `edit` (dokładne pliki kroków i testów) oraz `shards`, czyli spójne składowe grafu kroków. Krawędzie tego grafu to `dependsOn`, wspólny plik i import między plikami, więc między shardami nie ma żadnej krawędzi.

## Konsekwencje
### Pozytywne
- G4 ma deterministyczną część: krytyk planu dostaje tylko to, czego nie da się sprawdzić narzędziem.
- `pre-tool` może odrzucać edycje spoza `edit` bez interpretacji globów planu.
### Negatywne
- Kolejność według grafu działa tylko dla istniejących plików (importy nowych plików są nieznane przed ich napisaniem).
- `plan lint` uruchamia `patterns scan` (silniki detekcji) przy każdym wywołaniu.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Plan w Markdown | nie da się go sprawdzić bez parsowania prozy |
| Globy jako zakres edycji | szeroki glob otwiera pliki, których plan nie wymienia |
| Exemplar bez indeksu wzorców | plan mógłby wskazać dowolny plik jako „wzorzec” |
