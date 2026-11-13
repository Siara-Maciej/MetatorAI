# ADR-0086: Wycofanie pełnoekranowego `metator ui`; frontem graficznym jest aplikacja desktopowa

- Status: Proposed
- Data: 2026-11-13

## Kontekst
[ADR-0060](0060-terminal-ui-ink.md) wprowadził `metator ui`: pełnoekranowy widok w terminalu na Ink i React, z własną warstwą `TuiService`. Później powstała aplikacja desktopowa ([ADR-0077](0077-desktop-daemon-driver-lock.md), [ADR-0078](0078-desktop-app-tauri-xterm.md)), która rozmawia z demonem `metator serve` i pokazuje to samo: sesje, skrzynkę decyzji, terminale agentów, plan i zmianę.

Audyt CLI (2026-11-13) pokazał koszt utrzymywania dwóch frontów graficznych:
- `TuiService` budował kontenery sam i omijał demona, więc te same operacje istniały trzy razy: w komendach, w demonie i w TUI (start runu, odpowiedź z dopilnowaniem drive'a, kontynuacja). Wersje już się rozjechały: TUI wznawiał eskalowany run bez pytania, komenda `run continue` go odmawiała, a nowy run z TUI nie przygotowywał worktree.
- Reguła „które odpowiedzi wymagają słów człowieka” istniała w trzech miejscach i się różniła (`Deny`).
- CLI ciągnął `ink`, `@inkjs/ui`, `react`, `ink-testing-library` i `@types/react` tylko dla tego widoku: około 2400 linii kodu i testów.

Użytkownik zdecydował, że TUI nie jest potrzebny: jedynym frontem graficznym jest aplikacja desktopowa.

## Decyzja
- **Usuwamy** komendę `metator ui`, katalog `packages/cli/src/tui/`, jej testy (`packages/cli/test/tui.test.tsx`, `e2e/ui.e2e.test.ts`) i zależności CLI: `ink`, `@inkjs/ui`, `react`, `ink-testing-library`, `@types/react`. `react` i `@types/react` zostają w repozytorium jako zależności aplikacji desktopowej (ADR-0078).
- **Zostaje** wszystko, co nie jest widokiem Ink:
  - zwykłe komendy z jedną kopertą JSON na stdout;
  - pytania w terminalu na `@clack/prompts` (`packages/cli/src/terminal.ts`): kreator `metator setup`, kreator `metator run`, wybór runu i pytanie o wznowienie w `metator run continue`, odpowiedzi na pytania runu śledzonego na żywo (`run`, `run continue`), odpowiedź płynąca na żywo w `metator ask`;
  - `metator attach` (terminal na panelu demona), demon `metator serve`, serwer MCP.
- **Człowiek w terminalu dostaje tekst zamiast ekranu.** Komendy `status`, `inbox`, `run status`, `doctor`, `help` i każde `--help` piszą czytelny tekst na stderr, gdy stdin i stderr są terminalem; stdout zawsze niesie tę samą linię JSON, a `--json` wyłącza tekst. Czyste funkcje renderujące z `tui/model.ts` (`stageBar`, `duration`, `nextStep`, `fit`) przeszły do `packages/cli/src/render.ts`; `nextStep` podaje teraz komendę zamiast klawisza.
- **Samo `metator` w terminalu** nadal wypisuje przegląd komend według czasowników (`help --verbs`); nigdy nie otwierało TUI.
- Jedna reguła tożsamości (`who()`): `--by`, potem `$METATOR_USER`, `git config user.name`, nazwa logowania. Ścieżki TUI, które używały samej nazwy logowania, znikają razem z nim.

## Konsekwencje
- Jeden front graficzny i jeden klient demona; operacje na runach nie mają już trzeciej, ręcznej kopii w CLI.
- CLI nie zależy od Reacta ani Ink; `bun install` usuwa 5 pakietów.
- Kto pracował wyłącznie w terminalu, traci widok odświeżany na żywo i działania z klawisza. Zostają mu `metator status` i `inbox` z tekstem i gotową komendą przy każdym runie i pytaniu oraz `run`/`run continue` ze śledzeniem na żywo.
- W folderze repozytoriów przegląd wszystkich repozytoriów daje `metator status` (tekst pogrupowany po repozytoriach) i aplikacja uruchomiona na demonie folderu.
- Po akceptacji ten ADR zastępuje ADR-0060. Część ADR-0054 i ADR-0059 opisująca TUI jako odbiorcę `WorkOverview` przestaje obowiązywać; sam `WorkOverview` i `metator status` zostają.

## Alternatywy odrzucone
- **Zostawić TUI i przepiąć go na demona.** Usuwa duplikację logiki, ale zostawia dwa fronty do rozwijania i testowania oraz zależności Reacta w CLI.
- **Zostawić TUI tylko do odczytu.** Nadal osobny ekran i osobne testy, a działania i tak wymagałyby komend.
- **Wrócić do menu na `@clack/prompts` (ADR-0054).** ADR-0060 wykazał, że menu nie wystarcza do zarządzania pracą; tę rolę pełni aplikacja.

## Implikacje dla kodu
- `packages/cli/src/program.ts` nie rejestruje `ui`; podpowiedź w folderze repozytoriów wymienia `status`, `inbox`, `repos` i `ask`.
- `packages/cli/src/render.ts` trzyma renderery tekstu z testami w `packages/cli/test/render.test.ts`; mutanty z `scripts/mutants.ts` wskazujące `tui/` są usunięte albo przeniesione.
- `docs/metator/dependencies.yml`: wiersze `ink`, `@inkjs/ui`, `ink-testing-library` usunięte; `react` i `@types/react` wskazują ADR-0078.
- Dokumentacja użytkownika (`site/`) i README nie wspominają `metator ui`; [design/10 §3.4](../design/10-repos-ask-tui.md) ma notę o wycofaniu.
