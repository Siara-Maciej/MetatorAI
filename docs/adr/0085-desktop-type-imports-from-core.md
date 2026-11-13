# ADR-0085: Aplikacja desktopowa importuje z `@metator/core` wyłącznie typy

- Status: Proposed
- Data: 2026-11-13

## Kontekst
[ADR-0078](0078-desktop-app-tauri-xterm.md) ustalił, że `packages/desktop` nie importuje żadnego pakietu MetatorAI, a kształty odpowiedzi demona są przepisane ręcznie do `src/api.ts`. Koszt tej decyzji wyszedł w audycie aplikacji (2026-11-13):

- `src/api.ts` miało około 480 linii typów będących kopią typów z `packages/core` (`RunOverview`, `Question`, `DecisionCard`, `PlanBoardView`, `Issue`, `ReviewNote`, `OptionDescription` i dalsze). Demon (`packages/cli/src/serve/server.ts`) przekazuje te typy z core bez zmiany kształtu.
- Kopia rozjechała się z oryginałem w trzech miejscach, których test e2e nie złapał, bo żaden scenariusz ich nie dotykał:
  - `Overview.unreadable` (runy, których zapisu nie da się odczytać) nie istniało w kopii, więc aplikacja nigdzie ich nie pokazywała;
  - `ServiceReport.ports` jest w core mapą `nazwa → port`, a kopia deklarowała tablicę liczb; ekran sesji wołał na niej `join`, co przy runie z usługami kończyłoby się błędem w czasie działania;
  - `Pane` nie ma pola `workspace`, które kopia deklarowała; ponowne uruchomienie pane'a wysyłało do demona `workspace: undefined`.
- Powód zakazu z ADR-0078 był jeden: do paczki aplikacji nie może trafić kod MetatorAI (core ciągnie zod, xstate, neverthrow i logikę domenową). Import typu tego powodu nie narusza: przy `verbatimModuleSyntax` cała instrukcja `import type` znika w kompilacji.

## Decyzja
Po akceptacji ten ADR zmienia jeden punkt ADR-0078; reszta ADR-0078 pozostaje bez zmian (cienki klient, cała logika w demonie, logika widoku w `src/model.ts`, e2e na prawdziwym demonie).

- **Tylko `import type`, tylko z `@metator/core`.** `packages/desktop/src` może zawierać `import type { … } from "@metator/core"` (oraz `export type { … } from "@metator/core"`). Każda inna postać jest zabroniona: import wartości, `import { type X }` (zostawia w kodzie pusty import modułu), `import *`, import dla efektu ubocznego, `export … from`, `import()` oraz jakikolwiek import z innego pakietu MetatorAI (`@metator/runtime`, `@metator/cli`, `@metator/plugin-*`).
- **Brak importu w czasie działania.** Instrukcja `import type` jest usuwana przy budowie; paczka `vite build` nie zawiera kodu core. `@metator/core` jest w `devDependencies` pakietu (`workspace:*`), nie w `dependencies`.
- **Typ z core tam, gdzie demon przekazuje go bez zmian.** `src/api.ts` eksportuje typy core pod nazwami, których aplikacja już używa. Gdzie demon składa odpowiedź sam (`/supervisor`, `/workflows`, `/runs/:id/brief`, `/state` dla folderu, pole `repo` w skrzynce), kształt nadal jest zapisany lokalnie w `src/api.ts`.
- **Egzekwowanie (E1).** Reguły ast-grep `mt-arch-desktop-type-imports` (pliki `.ts`) i `mt-arch-desktop-type-imports-tsx` (pliki `.tsx`) w `rules/architecture/` z przypadkami w `rules/architecture-tests/`; biegną w `bun run arch`.

## Konsekwencje
### Pozytywne
- Zmiana kształtu w core wychodzi w `tsc` pakietu desktop, a nie u użytkownika. Trzy rozjazdy z sekcji „Kontekst” wyszły przy pierwszym typowaniu i zostały naprawione.
- `src/api.ts` zmalało z 674 do około 370 linii; zostały w nim klient HTTP i kształty, które demon składa sam.
- Paczka aplikacji jest tej samej wielkości: w `dist/` nie ma kodu core (sprawdzone po `vite build`).

### Negatywne
- Typecheck pakietu desktop zależy od tego, czy typy core się kompilują; błąd typów w core zatrzymuje też desktop.
- Kształty składane przez demona (`/supervisor`, `/workflows`, brief) nadal są kopią i nadal mogą się rozjechać; chroni je tylko e2e.
- Aplikacja zbudowana z innej wersji repozytorium niż demon, z którym rozmawia, dostaje typy swojej wersji, nie wersji demona. Pola dodane później muszą zostać opcjonalne po stronie aplikacji, tak jak dziś (`hostStatus`, `autonomy`, `unreadable`).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Zostawić ręczną kopię typów (ADR-0078 bez zmian) | trzy rozjazdy w kilka tygodni, z czego jeden kończyłby się błędem w czasie działania; e2e nie pokrywa każdego pola |
| Test zgodności typów poza pakietem (`e2e/`), kopia zostaje | usuwa ryzyko rozjazdu, ale zostawia 480 linii do utrzymania w dwóch miejscach |
| Generować typy klienta ze schematów (`metator config schema`, JSON Schema) | nowy krok budowy i nowa zależność dla narzędzia jednej osoby na localhost; typy widoków (`RunOverview`, `PlanBoardView`) nie mają schematów |
| Pozwolić na import wartości z core (np. `duration`, `inboxOf`) | wciąga do paczki zod, xstate i logikę domenową; łamie zasadę „aplikacja tylko rysuje” |
