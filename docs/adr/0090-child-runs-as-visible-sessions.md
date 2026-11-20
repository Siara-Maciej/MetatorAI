# ADR-0090: Runy potomne planu systemowego startują jako widoczne sesje

- Status: Proposed
- Data: 2026-11-20

## Kontekst
`system plan run` (ADR-0071) startował każdy run potomny z napędem w tle (`StartRun` z `drive`, czyli `EnsureDriven` i `metator run drive --detach`). Z prawdziwym hostem w Terminalach widać było tylko czat, w którym osoba dała zadanie; kafelki repozytoriów były puste, bo napęd w tle nie ma panelu. Właściciel produktu zdecydował: runy potomne mają startować jako widoczne sesje prawdziwego domyślnego agenta, a nie jako bezgłowe napędy.

Sesja dyrygenta (panel `role: conductor` z interaktywnym hostem) istnieje już: otwiera ją `metator run start` i `POST /runs/:run/start`. Panele należą do procesu demona (`metator serve`), a rdzeń nie może znać demona (porty i adaptery, ADR-0080).

## Decyzja
- **Run potomny startuje jako sesja dyrygenta.** `StartRun` przyjmuje `session: { host? }`. Wybiera host (`conductorHost`): host runu systemowego, gdy jest interaktywny i zainstalowany, inaczej pierwszy zainstalowany z `supervisor.hostOrder` (domyślnie copilot, claude, opencode). Otwiera sesję przez port `ConductorSessions` w repozytorium i worktree runu. `RunSystemPlan` prosi o sesję zamiast o napęd. Robotników dyrygent deleguje jak dotąd (`metator run delegate`), każdego w osobnym panelu.
- **Napęd w tle tylko jako wyjście awaryjne.** Gdy demon nie obsługuje repozytorium, gdy żaden host interaktywny nie jest zainstalowany albo gdy sesja nie wystartowała, run dostaje napęd w tle jak dotąd. Krok mówi, co się stało: `session: { paneId, host }` albo `noSession` (dlaczego) i `drive`. To samo jest w wyjściu CLI (`system plan run` przy terminalu: `session in pane w1:p1 on claude` albo `driven in the background on claude: no daemon runs for this repository`), w komunikacie bramki statusu runu systemowego i w aktywności runu.
- **Port w rdzeniu, adapter w CLI.** `ConductorSessions.open({ runId, host })` jest w `packages/core/src/ports/run-drive.ts`. Implementuje go `conductorSessions()` w `packages/cli/src/sessions.ts`: znajduje demona repozytorium (`findDaemon`) i woła `POST /runs/:run/start?repo=<root>` z hostem, tak jak `metator run start`. Także sam demon woła się w ten sposób, bo jego panele należą do jego kontenerów. Runtime rejestruje port z opcji `conductorSessions`. Bez tej opcji sesja prośby kończy się napędem w tle.
- **Run systemowy może zostać napędem w tle.** Prompt wejścia (intake) i agent `mt-orchestrator` mówią, że runy potomne są osobnymi sesjami i nie wolno ich napędzać. Prompt dyrygenta mówi, że dyrygent sam prowadzi swój run i nigdy nie startuje dla niego `metator run drive`. Etap z agentami `parallel` dzieli na części i deleguje każdą przed czekaniem, do limitu `limits.parallel`.

## Konsekwencje
- W Terminalach każde repozytorium planu ma od razu swój panel dyrygenta z prawdziwym hostem; osoba widzi, kto pracuje, i może przejąć klawiaturę.
- Sesja interaktywna potrzebuje działającego demona. Bez niego zachowanie jest takie jak przed tą decyzją, a krok mówi dlaczego.
- Run potomny z sesją nie ma napędu w tle; nadzorca demona wznawia martwą sesję dyrygenta aktywnego runu (jak dla `run start`).
- Wynik `StartedStep` ma nowe pola `session` i `noSession`; `drive` jest tylko przy wyjściu awaryjnym.

## Alternatywy odrzucone
- **Napęd w tle z panelem podglądu.** Napęd nie jest interaktywny; osoba nie może pisać do agenta ani przejąć klawiatury.
- **Rdzeń woła demona przez HTTP.** Łamie kierunek zależności (rdzeń nie zna adapterów); reguły `rules/architecture` by to odrzuciły.
- **Osoba otwiera każdy run potomny sama (`run start`).** Tak było; właściciel chce, żeby sesje były widoczne bez dodatkowych kroków.

## Implikacje dla kodu
Decyzję egzekwują reguły architektury (`bun run arch`: rdzeń nie importuje adapterów) i MT-TEST-003 (mutanty dla `conductorHost`, wyboru sesji lub napędu w `StartRun`, prośby o sesję w `RunSystemPlan` i `startedHow`).

- `packages/core/src/domain/conductor.ts`: `conductorHost`, prompt dyrygenta (`parallel`, bez `run drive`).
- `packages/core/src/ports/run-drive.ts`: `ConductorSessions`, `ConductorSession`.
- `packages/core/src/application/run-operations.ts`: `StartRunInput.session`, `VisibleSessions`, `StartedRun.session` i `noSession`.
- `packages/core/src/application/system-runs.ts`: `StartedStep.session` i `noSession`, `startedHow`.
- `packages/runtime/src/bootstrap.ts`: opcja `conductorSessions`.
- `packages/cli/src/sessions.ts`: adapter `conductorSessions()`; `packages/cli/src/render.ts`: `renderPlanRun`.
