# ADR-0079: herdr jako runtime terminali, MetatorAI jako warstwa zabezpieczeń nad nim

- Status: Proposed
- Data: 2026-11-08

## Kontekst
herdr (https://github.com/herdrdev/herdr, Apache-2.0, Rust) robi to, co planowaliśmy w D3 i D7: serwer w tle trzyma terminale agentów, sesje przeżywają odłączenie klienta, workspace'y, karty, panele, zdalne maszyny, rozpoznawanie stanu 25 agentów (working, blocked, idle), wtyczki i API przez gniazdo. Przegląd bezpieczeństwa (2026-11-07) pokazał, że jest solidny jako lokalny multiplekser jednej osoby (gniazdo 0600, ACL potoku na Windows, StrictHostKeyChecking, akcje CI przypięte do SHA, `cargo-audit` bez podatności), ale nie jest warstwą kontroli agentów:

- dowolny proces w dowolnym panelu steruje każdym innym panelem; `agent send-keys` i `pane send-keys` nie mają blokady na agenta czekającego na zgodę, więc jeden agent może zatwierdzić zgodę drugiemu (chroni przed tym tylko zdanie w skillu);
- proces w panelu może zgłosić komendę wznowienia (`bash -c …` przechodzi walidację), którą herdr wpisze po restarcie serwera;
- wtyczki działają bez piaskownicy; aktualizacje i manifesty detekcji mają tylko SHA-256 z tego samego serwera;
- integracje z agentami tylko raportują stan, nie blokują narzędzi.

Właściciel zdecydował: używamy herdr jako runtime z naszą warstwą zabezpieczeń.

## Decyzja
- **Strażnik herdr w hooku `pre-tool`** (`herdrRefusal`, domena): agent nie pisze do paneli (`agent send-keys|attach`, `pane send-text|send-keys|send-input|run|input`, `terminal attach`, `session attach`), nie promptuje innych agentów (`agent prompt`; zamiast tego `metator run message`, czyli dane), nie startuje agentów poza runem (`agent start`, `metator herdr open`), nie zgłasza komend wznowienia (`pane report-agent*`, `release-agent`), nie zmienia wtyczek ani integracji, nie zamyka cudzej pracy (`workspace|tab|pane close`, `worktree remove`, `server stop`, `session stop`, `metator herdr close`), nie ufa repozytoriom (`--trust-repository`), nie zmienia maszyn SSH ani nie aktualizuje herdr, i nie sięga do gniazda herdr bezpośrednio (`HERDR_SOCKET_PATH`, `herdr.sock`). Odczyt, listy, `wait`, układ i powiadomienia zostają otwarte. Ta sama reguła działa w hoście SDK Claude w procesie.
- **Port `HerdrControl`** (open, run, status, report, close) i adapter `HerdrCli` (`@metator/plugin-herdr`) na udokumentowanym CLI herdr; MetatorAI nigdy nie rozmawia z gniazdem herdr.
- **`InteractiveHost.launch`**: komenda hosta bez uruchamiania (argv, id sesji, zmienne runu), żeby herdr wpisał ją we własnym panelu z tymi samymi flagami co nasz broker PTY.
- **`HerdrSessions`** i `metator herdr open|sync|close`: workspace herdr na run (cwd = worktree, etykieta = id runu, zmienne `METATOR_RUN`, `METATOR_RUN_DIR`, `METATOR_DRIVEN`), host z flagami runu (Copilot z `--deny-tool shell(git push)`), dokument `HerdrBinding` v1 w katalogu runu, maszynowy indeks `HerdrWorkspaces` v1 (workspace → repozytorium i run). `sync` pisze etap runu do paska bocznego herdr (`pane report-metadata`, źródło `metator`) i odnotowuje w aktywności runu, gdy herdr widzi hosta zablokowanego na własnym oknie zgody, którego MetatorAI nie zadało.
- **Wtyczka herdr** (`integrations/herdr`): akcje attach, release, sync; panel z `metator ui`; hook zdarzenia `pane.agent_status_changed` uruchamia `metator herdr plugin sync`.
- Broker PTY (D3) i aplikacja desktopowa (D7) zostają w repozytorium jako alternatywa bez herdr; nie rozwijamy ich dalej.

## Konsekwencje
### Pozytywne
- Interfejs, sesje, zdalne maszyny i detekcja stanu agentów pochodzą z herdr; MetatorAI zostaje przy tym, czego herdr nie robi: workflowy, bramki, blokada kierowcy, polityka narzędzi, karta decyzji.
- Strażnik działa w momencie wywołania narzędzia, więc odmowa nie zależy od tego, kto i jak naciśnie klawisz w panelu.

### Negatywne
- Strażnik widzi tylko komendy agenta. Agent z pełnym Bash może napisać skrypt, który sięgnie do gniazda inaczej; reguła łapie typowe formy (CLI, `HERDR_BIN_PATH`, `nc -U`, `socat`, `--unix-socket`), nie wszystkie. Pełna izolacja wymagałaby autoryzacji po stronie herdr (zgłoszenie u autorów: blokada `send-keys` dla agenta `blocked`, tożsamość wywołującego panelu).
- Ludzie i procesy spoza agentów nadal mogą sterować herdr bez ograniczeń; to model zaufania herdr (jak tmux).
- Kształty JSON herdr (`workspace create`, `pane get`) są przepisane do adaptera z dokumentacji; test na prawdziwym herdr (`METATOR_E2E_HERDR`) musi przejść przed wydaniem.

## Implikacje dla kodu
- `HerdrBinding` v1, `HerdrWorkspaces` v1: nowe dokumenty z zamrożonym schematem.
- `InteractiveHost` ma cztery elementy (MT-ARCH-008); `HerdrControl` pięć.
- Mutanty: klasyfikacja komend herdr, notatka o oknie hosta, indeks workspace'ów.
