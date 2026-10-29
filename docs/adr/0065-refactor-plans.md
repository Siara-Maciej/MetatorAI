# ADR-0065: Plany refaktoru (`RefactorPlan`, `mt-arch-planner`, wykonanie runami W3)

- Status: Accepted
- Data: 2026-10-29

## Kontekst
Ruchy i ich symulacja (ADR-0064) mówią, co pojedynczy ruch zrobi. Refaktor dużego monorepo to wiele ruchów w kolejności. Trzeba też uzasadnić odpowiedzialność każdego ruchu, uzyskać zatwierdzenie człowieka i wykonać całość w kawałkach, które da się zrecenzować ([design/11 §5.5](../design/11-package-architecture.md)).

## Decyzja
- **`RefactorPlan` v1** (`metator/arch/plans/<id>.yml`): `id`, `title`, `goal` (`no-cycles`, `no-errors`, `fewer-violations`), `status` (`draft`, `approved`, `running`, `done`), `approval { by, at, digest }` i `moves`. Każdy ruch ma:
  - `id`, `move` (ADR-0064);
  - `why`: odpowiedzialność, którą ruch porządkuje;
  - `citations` (`path[:line]`) i `wave`;
  - `status`, `run`, `note`;
  - `effect`, wpisywany wyłącznie przez `arch plan simulate`.
  
  `result` to podsumowanie przed całym planem i po nim.
- **Lint** (`arch plan lint`, E1):
  - zatwierdzenie nadal obejmuje ruchy (digest FNV ruchów, fal i id, bez uzasadnień i stanu);
  - plan ma ruchy, id są unikalne, fale idą 1, 2, 3… bez luk;
  - cytaty istnieją;
  - każdy ruch jest możliwy na stanie po ruchach przed nim (pakiet utworzony przez wcześniejszy `extract` jest znany);
  - efekty i wynik są aktualne;
  - plan nie dodaje błędu i osiąga cel;
  - ruch, który sam nic nie naprawia, daje ostrzeżenie.
- **`arch plan propose`** uruchamia `mt-arch-planner` na hoście AI, tak jak `ask` uruchamia `mt-guide`:
  1. świeży raport;
  2. szkic planu;
  3. agent czyta raport, karty i kod, próbuje ruchów przez `arch simulate` i wpisuje je do pliku;
  4. narzędzie symuluje i lintuje to, co agent napisał.
  
  Agent edytuje tylko plik planu, kodu nie zmienia.
- **Zatwierdza człowiek:**
  - `arch plan approve` wymaga czystego lintu i zapisuje `{ by, at, digest }`;
  - hook `PreToolUse` odmawia agentowi `metator … arch plan approve`, także z opcjami przed podkomendą;
  - `run approve` zostaje bez zmian, bo orchestrator przekazuje nim decyzję człowieka z czatu.
- **Wykonanie** (`arch plan run`):
  - tylko plan `approved`/`running` z aktualnym digestem;
  - startuje następną falę: każdy oczekujący ruch jako run `mt-refactor` (W3: snapshot API, testy charakteryzujące, `api diff`, `graph diff`) w osobnym worktree;
  - zadanie runu nazywa ruch, jego uzasadnienie i dowody.
  
  `arch plan status` przepisuje stan runów do ruchów: `done`, `blocked` z powodem dla `aborted` i `escalated`. Plan jest `done`, gdy wszystkie ruchy są `done`.

## Konsekwencje
### Pozytywne
- Agent proponuje, liczby rozstrzygają, człowiek zatwierdza, a W3 wykonuje i dowodzi równoważności. Żaden etap nie polega na zaufaniu do modelu.
- e2e na prawdziwym repo z hostem scenariuszowym:
  - propozycja, efekty i czysty lint;
  - odmowa runu dla szkicu, zatwierdzenie, edycja po zatwierdzeniu wymagająca nowego zatwierdzenia;
  - fala jako run W3 w worktree;
  - przerwany run blokuje ruch.
### Negatywne
- Kolejne fale opierają się na stanie runów, a nie na tym, czy zmiany trafiły do gałęzi głównej. Po merge'u fali warto ponownie przeprowadzić `arch plan simulate` i lint.
- Powiązanie runu z planem żyje w planie (`move.run`), a nie w `RunRecord`. Runy rodzic–dziecko należą do F7.6.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Nowy workflow „W14” z etapem planowania | wykonanie i tak jest W3 per ruch; planowanie to jedno wywołanie agenta jak `ask` |
| Efekty pisane przez agenta | agent mógłby napisać liczby, które chce; wpisuje je tylko narzędzie, a lint sprawdza aktualność |
| Jeden run W3 na cały plan | nie do zrecenzowania przy 30 pakietach; fale i jeden run na ruch dają małe PR-y |

## Implikacje dla kodu
ADR-0065 egzekwują reguły kanonu MT-CODE-002, MT-TEST-001 (`metator rules show <id>`).
