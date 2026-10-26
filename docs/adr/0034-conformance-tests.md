# ADR-0034: Testy zgodności jako silnik E1 i kanon w 100% egzekwowany narzędziami

- Status: Proposed
- Data: 2026-10-26

## Kontekst
Kanon MetatorAI miał 12 z 20 reguł E1 (60%). Pozostałe 8 (E2/E3) zależały od review albo osądu, więc nic nie gwarantowało, że zawsze są spełnione. Części z nich nie da się sprawdzić na jednym pliku (ast-grep, Biome i tsc widzą plik albo projekt, a nie relacje „komenda ↔ test e2e”, „adapter ↔ contract suite”, „wersja dokumentu ↔ zamrożony schemat”). Reguły sformułowane jako proces („najpierw failing test”, „szukaj pakietu”) nie były sprawdzalne w ogóle.

## Decyzja
- **Silnik `test`** (`BunTestEngine`, `plugin-bun`, port `RuleEngine`): reguła `test:<id>` trzyma się, dopóki `rules/conformance/<id>.test.ts` przechodzi pod `bun test`. Reguła ma test, gdy plik zawiera przypadek `test("rejects ...")`, który dowodzi, że sprawdzenie odrzuca złe wejście. Testy zgodności czytają całe repo i ignorują listę zmienionych plików.
- **Nowe reguły ast-grep:** `mt-arch-006` (use case konstruuje tylko wartości z domeny i typy wbudowane), `mt-arch-008` (port ma co najwyżej pięć członków), `mt-code-002` (brak surowego `JSON.parse`/`JSON.stringify`/`yaml` w core poza `domain/versioned.ts`; dochodzi `renderYamlDocument`).
- **Testy zgodności:**
  - MT-CODE-003: każda wersja dokumentu ma migawkę schematu w `docs/metator/schemas/` (`bun run schemas:freeze` dopisuje brakujące i nigdy nie nadpisuje), a każda starsza wersja ma przykład, który musi się zmigrować;
  - MT-CODE-005: każda zależność jest w `docs/metator/dependencies.yml` z potrzebą i ADR (w tym `playwright` do e2e wizualizacji README);
  - MT-TEST-001: każda komenda programu commander jest uruchamiana w teście e2e;
  - MT-TEST-002: adapter portu z contract suite woła ją w swoich testach;
  - MT-TEST-003: każdy moduł core i pluginów z zachowaniem ma mutanta w `scripts/mutants.ts`.
- **Przeformułowanie reguł procesowych** na sprawdzalne: MT-CODE-005 brzmi „każda zależność ma ADR”, a MT-TEST-003 „każdy moduł ma zabijanego mutanta”. Sam proces (failing test przed poprawką, szukanie pakietu przed własnym kodem) zostaje w AGENTS.md i soczewkach review jako praktyka, ale nie jest regułą kanonu.
- `bun run canon` wymaga `rules coverage --min-e1 100`.

## Konsekwencje
### Pozytywne
- Każda reguła kanonu jest sprawdzana deterministycznie w CI; nowa reguła E2/E3 obniża pokrycie poniżej 100% i zatrzymuje build.
- Sprawdzenia od razu znalazły luki: 4 komendy bez e2e (`* schema`) i 7 zachowań bez testów (mutanty przeżyły).
### Negatywne
- `rules check` uruchamia `bun test` dla każdego testu zgodności, także w bramce `quick` (ok. 0,2 s na plik).
- Testy zgodności to kod MetatorAI, nie produktu: inne repo muszą napisać własne (silnik jest generyczny).
- Limit pięciu członków portu jest progiem, a nie pełnym kryterium „osi zmiany”.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Pozostawić reguły E2/E3 | brak gwarancji, że zawsze są spełnione |
| Relacje między plikami w ast-grep | ast-grep dopasowuje w obrębie pliku |
| Raport JUnit z `bun test` | wymaga parsera XML; kod wyjścia i linie `(fail)` wystarczają |
| Snapshoty `toMatchSnapshot` | `bun test -u` nadpisuje je jednym poleceniem, czyli zmiana w miejscu |
