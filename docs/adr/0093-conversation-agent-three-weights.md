# ADR-0093: Agent rozmowy: jeden „mózg”, trzy wagi pracy i deterministyczne eskalatory

- Status: Proposed
- Data: 2026-11-21

## Kontekst
Decyzje właściciela produktu z rozmowy 2026-11-20/21. Dotyczą rozmowy z agentem w terminalu Claude Code albo Copilot CLI (czat „+ New run” i sesje w repozytorium), w jednym oknie aplikacji.

Stan dzisiejszy:
- Czat wejścia to panel bez runu z agentem `mt-orchestrator` i promptem `INTAKE_PROMPT` (`packages/core/src/application/panes.ts`). Prompt zna dwie drogi: odpowiedź na pytanie z cytatami `plik:linia` albo start runu (`metator run init`, potem `metator run drive --detach`). Tryb wejścia w `metator/agents/mt-orchestrator.md` mówi to samo: przy prośbie o zmianę agent pyta o workflow, autonomię, worktree i repozytorium, a potem woła `metator run new --workflow <id>`.
- `mt-orchestrator` nie edytuje kodu (reguła 1 agenta; `capabilities` bez edycji). Każda zmiana, także jedna linia `console.log`, idzie więc przez pełny workflow.
- Workflowy w `.github/metator/workflows/` to `mt-feature`, `mt-bugfix`, `mt-refactor`, `mt-pr-review`, `mt-self-review`, `mt-review-response` i `mt-system-change`. Lekkiego nie ma. `mt-feature` i `mt-bugfix` wymagają czystego drzewa (`preconditions: [clean-tree, branch-ok]`). Słowo „quick” oznacza dziś tylko profil bramek (`gates.quick`, ADR-0029).
- Narzędzia, z których da się policzyć eskalatory, już są: `system impact` (ADR-0068), `contract diff` (ADR-0069), `api diff` (ADR-0040), `graph dependents` i `graph affected` (ADR-0036), `coverage diff` (ADR-0041).
- Zmiany debugowe są znane tylko jako znaczniki `[DEBUG-xxxx]` skilla `mt-diagnose` i komenda `debug-tags check` (`packages/core/src/domain/debug-tags.ts`, ADR-0044). Nic nie pamięta zmian zrobionych w rozmowie.
- Sesje podrzędne: czat jest terminalem głównym zadania (`startedRun` w `packages/core/src/domain/layout.ts`) i dostaje jedną linię, gdy zadanie się skończy (`ChatNotices`, ADR-0092). Runy potomne są widocznymi sesjami (ADR-0090). Dyrygent nie pisze do cudzych paneli (ADR-0080); między runami idą wiadomości `metator run message`, czytane przy następnym etapie (`packages/core/src/application/run-messages.ts`). Trasy paneli (`packages/cli/src/serve/routes/panes.ts`) nie mają drogi „przekaż” ani „przerwij”. Osoba może pisać w terminalu sesji bezpośrednio (`metator attach <pane>`, blokada kierowcy z ADR-0077).

## Decyzja
- **Jeden agent rozmowy.** Nie osobny tryb i nie „wolna amerykanka”. Ma wszystkie uprawnienia, sam rozpoznaje, czego osoba chce, wie, jak działa MetatorAI, i pilnuje, by konteksty były dobrze grupowane i zapisywane. Orchestratora uruchamia dopiero wtedy, gdy trzeba, po ewentualnych pytaniach.
- **Agent sugeruje drogę, decyduje osoba.** Agent proponuje, czy zadanie idzie pełnym workflowem, czy nie; decyzja jest zawsze osoby.
- **Trzy wagi pracy:**
  1. **Bezpośrednio, bez pytania.** Luźna rozmowa i zmiany nie do commita (`console.log`, tymczasowe flagi), także w kilku plikach. Zawsze w bieżącym checkoucie, także gdy jest brudny, chyba że osoba powie inaczej.
  2. **Quick.** Agent proponuje („za proste na pełny workflow”) i pyta o zgodę. Pracę wykonuje osobny worker w widocznym terminalu, a czat zostaje wolny. Etapy: zmiana → lint, typy i testy dotkniętych plików → krótkie review. Blokujące uwagi review agent poprawia sam (raz) i pokazuje wynik. Quick kończy się niezacommitowanym diffem do obejrzenia.
  3. **Pełny workflow.** Jak dziś: orchestrator w osobnym terminalu, czat jest terminalem głównym, także w jednym repozytorium.
- **Brudny branch dla quick.** Czysty: bieżący branch. Brudny: agent pyta, czy pracować na bieżącym, czy w osobnym worktree.
- **Zmiany debugowe.** MetatorAI je pamięta. „Usuń zmiany debugowe” to jedno kliknięcie. Przy próbie commita jest ostrzeżenie.
- **Eskalatory quick → pełny.** Są deterministyczne i liczone dwa razy: przed startem (z przewidywanych plików) i po zmianie (z diffu):
  - więcej niż jedno repozytorium albo dotknięty kontrakt (`system impact`, `contract diff`);
  - zmienione publiczne API pakietu (`api diff`);
  - przecięcie granicy pakietów albo wielu zależnych (`graph dependents`, `graph affected`);
  - migracja, wersja schematu, nowa zależność, konfiguracja CI;
  - kod bez testów;
  - rozmiar ponad próg (np. 5 plików albo 150 linii; próg w konfiguracji).

  Jeden trafiony eskalator oznacza, że quick jest niedostępny, a agent mówi, który to był. Osoba może to nadpisać jednym zdaniem, co zostawia ślad w aktywności. Eskalatora „więcej niż jedno repozytorium” (cross-repo) nie da się nadpisać nigdy.
- **Sterowanie sesjami podrzędnymi, dwie drogi.** (1) Ciągła rozmowa z czatem głównym, który przekazuje prośby osoby do sesji podrzędnych (dodaje informacje) albo przerywa ich pracę. (2) Bezpośrednia rozmowa z subagentem w jego terminalu.

### Kolejność wdrożenia (zaakceptowana przez właściciela)
1. Agent rozmowy z blokadami i trzema wagami pracy, eskalatory (ten ADR i ADR-0094).
2. Wątki i pamięć; analiza w Backlogu z „Zrób plan” (ADR-0095, ADR-0096).
3. Review cudzego MR z linku, obserwowanie, ponowne review; karty review moich MR (ADR-0097).
4. Zestaw zgodności Copilot CLI / Claude Code (ADR-0098).

## Konsekwencje
- Drobna zmiana nie kosztuje już pełnego workflowu, a zmiana nie do commita nie kosztuje nawet pytania.
- Agent rozmowy edytuje pliki. Dzisiejszy czat wejścia (`mt-orchestrator`, tylko czytanie i start runu) tego nie robi, więc zmieniają się prompt wejścia, uprawnienia agenta i to, co hook `pre-tool` przepuszcza poza runem (ADR-0094).
- Quick potrzebuje osobnego workera w widocznym terminalu i krótkiego review; żadnego z nich dziś nie ma poza runem.
- Eskalatory liczone z narzędzi dają ten sam wynik na obu hostach i dają się testować bez agenta. Wynik zależy od indeksu importów, więc indeks musi być aktualny przed startem quick.
- W jednym repozytorium pełny workflow ma mieć orchestratora w osobnym terminalu. Prompt wejścia każe dziś napędzać taki run w tle (`metator run drive --detach`).
- Droga „czat główny przekazuje albo przerywa” zmienia jedną zasadę ADR-0080 (nikt poza osobą nie wpływa na cudzy panel); jak to zrobić bez powtórzenia luki opisanej w ADR-0079, jest pytaniem otwartym.

## Zastępuje i rozszerza
- Rozszerza ADR-0083 (CLI agenta jako punkt wejścia): wejście A ma trzy wagi zamiast dwóch dróg.
- Zmienia prompt wejścia opisany w ADR-0090 i ADR-0092 (czat jako terminal główny zostaje).
- Rozszerza ADR-0080 o sterowanie sesjami podrzędnymi z czatu głównego.
- Niczego nie zastępuje w całości.

## Pytania otwarte
- Czy agent rozmowy to nowy agent kanoniczny, czy przebudowany tryb wejścia `mt-orchestrator` (dziś czat startuje właśnie tego agenta)?
- Czy quick jest workflowem z runem (`RunRecord`, aktywność, bramki), czy lżejszym bytem? Od tego zależy, gdzie trafia „ślad w aktywności” przy nadpisaniu eskalatora.
- Wartości domyślne progów (pliki, linie, liczba zależnych) i ich klucze w konfiguracji.
- Jak mierzyć „kod bez testów”: `coverage diff`, brak testów w `test affected`, czy inaczej?
- Co się dzieje z gotowym diffem, gdy eskalator trafi dopiero po zmianie?
- Co, jeśli po jednej samodzielnej poprawce review nadal ma blokujące uwagi? Z jakich soczewek składa się „krótkie review”?
- Jak MetatorAI pamięta zmiany debugowe (znaczniki, zapis plików i fragmentów) i gdzie pokazuje ostrzeżenie przy commicie?
- Mechanizm „przekaż” i „przerwij”: pisanie do panelu, wiadomość, czy przerwanie tury hosta; co przerwanie robi ze stanem runu; jak działa tak samo na obu hostach (ADR-0098).
- Jak w jednym repozytorium startuje terminal orchestratora: sesja dyrygenta (`metator run start`) zamiast napędu w tle?

## Implikacje dla kodu
Decyzję będą egzekwować MT-TEST-003 (mutant dla każdego eskalatora i dla wyboru wagi), MT-TEST-001 (e2e na prawdziwym procesie `metator` dla quick i dla nadpisania eskalatora) i MT-CODE-003 (progi w konfiguracji to nowa wersja `MetatorConfig` z migracją). Kod zmieni się dopiero po akceptacji; miejsca, których decyzja dotyczy:

- `packages/core/src/application/panes.ts`: `INTAKE_PROMPT`.
- `metator/agents/mt-orchestrator.md`: tryb wejścia (pliki w `.github/agents/` i `.claude/agents/` są generowane).
- `.github/metator/workflows/`: brak lekkiej drogi.
- `packages/core/src/domain/hook.ts`: `preToolPolicy` (edycje poza runem, koordynator nie edytuje).
- `packages/core/src/domain/debug-tags.ts`: dzisiejsze znaczniki debugowe.
- `packages/cli/src/serve/routes/panes.ts`, `packages/core/src/application/chat-notices.ts`: droga między czatem a sesjami podrzędnymi.
