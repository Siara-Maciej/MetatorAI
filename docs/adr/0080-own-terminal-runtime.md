# ADR-0080: Własny runtime terminali wzorowany na herdr: workspace, pane, dyrygent, sensor

- Status: Proposed
- Data: 2026-11-09

## Kontekst
ADR-0079 proponował herdr jako runtime terminali pod naszą warstwą zabezpieczeń. Właściciel zdecydował inaczej: nie używamy herdr, budujemy własne rozwiązanie o podobnym działaniu. Przegląd bezpieczeństwa herdr z ADR-0079 zostaje jako lista rzeczy, których nie powtórzymy: brak tożsamości wywołującego panelu, pisanie do cudzych paneli przez każdy proces, komendy wznowienia zgłaszane przez procesy w panelach.

Fundament już istnieje (D3–D7): demon `metator serve`, broker PTY na node-pty, hosty interaktywne (Copilot CLI, Claude Code, OpenCode, scenariusz), blokada kierowcy, inbox z kartą decyzji, supervisor, worktree z portami, aplikacja desktopowa. Brakuje modelu workspace/pane, trybu dyrygenta z delegowaniem do widocznych pane'ów, sensora stanu agenta z ekranu, klienta terminalowego i odtwarzania układu po restarcie.

## Decyzja
- **Layout jako dokument.** `Layout` v1 w `.metator/layout.json`: workspace (run albo repozytorium; `group` wskazuje workspace nadrzędny), tab, pane z rolą (`conductor`, `worker`, `apps`, `gate`, `shell`) i procesem (`host` z `sessionId` do wznowienia albo `command` z argv). Identyfikatory liczą w górę i nie są używane ponownie. Demon po starcie odtwarza każdy pane: sesje hostów wznawia (`--resume`), komendy uruchamia ponownie.
- **Broker PTY kluczowany pane'em**, z backlogiem, fan-outem i bezczynnością; pisanie do pane'a runu tylko od osoby z blokadą kierowcy, do pane'a bez runu od każdego, kto się przedstawi.
- **Tożsamość pane'a.** Każdy pane dostaje `METATOR_PANE_ID`, `METATOR_PANE_TOKEN` (w pamięci demona, nowy po restarcie) i `METATOR_ROLE`. Demon wie, kto woła: pane działa tylko na własnym runie. To luka herdr, której nie powtarzamy.
- **`.metator/daemon.json`** (`DaemonInfo` v1) mówi, gdzie demon nasłuchuje; CLI (`metator pane list|read|wait`) jest klientem demona i tylko czyta.
- **Dyrygent w granicach workflow (R2).** Run startuje jako pane dyrygenta: interaktywny Copilot z agentem orkiestratora. Workflow jest sztywny (etapy, bramki HITL, właściciele etapów, limity pętli); w jego granicach agent decyduje dynamicznie. Delegowanie przez `metator run delegate` otwiera pane workera z kartą pracy podaną przy starcie; wyniki wracają jako artefakty (`WorkerResult` v1), nigdy przez pisanie do cudzego panelu; `run wait` i `run collect` zamykają pętlę. Rola `worker` w hookach nie steruje runem.
- **Sensor stanu (R3).** Hooki hosta dają `working`; `HostManifest` v1 (wzorce ekranu, dane) rozpoznaje `blocked` (okno zgody hosta) i `idle`; wyjście procesu to koniec. Okno zgody hosta trafia do inboxa z akcją attach, bo odpowiada na nie tylko osoba.
- **Klienci (R4).** Aplikacja desktopowa na modelu workspace/pane; `metator attach <pane>` jako klient terminalowy w trybie raw z prefiksem odłączenia. Supervisor (R5) wznawia dyrygenta, nudge'uje i liczy budżet uwagi na pane'ach.
- Deterministyczny `run drive` zostaje dla trybu headless w CI (L2).

## Konsekwencje
### Pozytywne
- Jedno źródło prawdy (`.metator/runs` i `layout.json`), nic w demonie, czego nie da się odtworzyć.
- Hosty wymienne przez `InteractiveHost`; Copilot pierwszy, Claude Code potem bez zmian w runtime.

### Negatywne
- Każdy worker to osobna sesja hosta z własnym kontekstem (koszt tokenów); zysk to widoczność, attach i wznawianie.
- Wzorce ekranu Copilota wymagają kalibracji na prawdziwym hoście; do tego czasu `blocked` z ekranu jest przybliżeniem, a hooki dają pewne `working`.

## Implikacje dla kodu
- Nowe dokumenty: `Layout` v1, `DaemonInfo` v1, `WorkerResult` v1, `HostManifest` v1 (zamrożone schematy).
- `AgentTask.env` dla tożsamości pane'a; `PtyView` z `paneId` i rolą; `Panes` jako use case nad `LayoutStore` i brokerem.

## Stan realizacji (2026-11-09)
R1–R5 zrealizowane na gałęzi `claude/foundation`: `Layout` v1 i odtwarzanie po restarcie, tożsamość pane'a i `metator pane`, dyrygent (`run start|delegate|wait|collect|workers|result`, `WorkerResult` v1, rola `worker` w hookach), sensor (`HostManifest` v1, stany pane'ów, okna zgody hosta w inboxie z akcją attach, heartbeat z hooków), klienci (`metator attach <pane>`, zakładki pane'ów i ich stany w aplikacji), grupy worktree'ów pod workspace'em repozytorium, `run close` zamykający pane'y runu (i opcjonalnie worktree), supervisor wznawiający dyrygenta. Otwarte: kalibracja wzorców ekranu Copilota na prawdziwym hoście; Claude Code jako drugi host; siatka pane'ów w aplikacji (dziś siatka pokazuje dyrygentów runów).
