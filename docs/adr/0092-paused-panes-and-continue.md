# ADR-0092: Panel zabity razem z demonem jest wstrzymany, a nie zakończony; jedno „Continue” dla zadania

- Status: Proposed
- Data: 2026-11-20

## Kontekst
Prawdziwy przebieg z Claude Code (system run w trzech repozytoriach) zatrzymano: SIGTERM do demona i zabicie każdego procesu w folderze. Po ponownym starcie żadna sesja agenta nie wróciła. Panel, którego proces znikał, był oznaczany jako `ended: exited` (kod 129 od SIGHUP), a `restore` pomija panele zakończone. Prowadzący musiał wołać `POST /runs/:run/start` dla każdego runu. Powstawały nowe sesje z pustymi ekranami, a praca robotników przepadła. Napęd w tle runu systemowego nie wystartował ponownie i run stał na `status`, dopóki ktoś go nie popchnął.

Właściciel produktu chce:
1. sesje agentów dają się kontynuować po zabiciu demona;
2. czat, w którym podano zadanie, wie, kiedy zadanie się skończyło;
3. pytanie hosta pokazuje początek polecenia, a kliknięcie całe;
4. zamknięcie i otwarcie aplikacji niczego nie zmienia, a kontynuacja to jedno „Continue”.

## Decyzja
- **Wstrzymany, a nie zakończony.** Panel hosta ma `paused: { at, why: "daemon-stopped" | "process-lost" }` (Layout v4). Przy zatrzymaniu demon (SIGTERM, SIGINT) wstrzymuje każdą żywą sesję hosta (`Panes.pauseAll`), zanim jej proces zniknie razem z nim. Proces hosta zakończony sygnałem (kod ≥ 128, np. 129 po SIGHUP) w czasie pracy demona jest wstrzymany jako `process-lost`. Host, który wyszedł sam (kod < 128), oraz polecenia w panelach kończą się jak dotąd (`ended`). Panel wstrzymany zachowuje `process.sessionId` i ostatni ekran. Demon zapisuje ekrany wszystkich paneli na dysk co kilka sekund (`--screens-ms`, domyślnie 5000), więc SIGKILL traci najwyżej kilka sekund.
- **Wznowienie w tym samym panelu.** Przy starcie demon wznawia sesję hosta każdego panelu, który nie jest zakończony, a jego run jest aktywny albo go nie ma (czat). To obejmuje panele wstrzymane i panele, które po SIGKILL wyglądają na żywe. Wznowienie używa sesji hosta po jej id (`claude --resume <id>`) w tym samym id panelu i pokazuje zachowany ekran nad nowym wyjściem. `metator serve --no-restore` zostawia je wstrzymane do „Continue”. Gniazdo wstrzymanego panelu wysyła `{type:"paused", paused}` i ostatni ekran, a wpisywanie odrzuca.
- **Wznowiona sesja dostaje jedną linię.** Wznowienie hosta (`claude --resume`) przywraca rozmowę, ale nie turę: agent stoi przy „Interrupted” i czeka. Po wznowieniu dyrygenta albo robotnika (start demona, „Continue” panelu albo zadania), gdy agent jest bezczynny przy swoim prompcie i nikt nie trzyma klawiatury runu, demon wpisuje jedną linię drogą `nudge` (`ResumeNotices`). Dyrygent dostaje „Continue where you stopped…”, robotnik „Continue your card…”. Linia idzie raz na wznowienie i trafia do aktywności. Nadzorca nie popycha takiej sesji drugi raz. Czat bez runu tej linii nie dostaje.
- **„Continue” zadania.** `POST /runs/:run/continue { by }` i `metator run continue [--run <id>]` przez demona zwracają `{ resumed: { repo?, paneId, role, sessionId }[], drives: { repo?, runId, host }[], skipped: { repo?, paneId?, runId?, why }[] }`. Obejmują run, wszystkie runy pod nim (dzieci runu systemowego, runy z `--parent`) we wszystkich repozytoriach demona oraz czat z `startedRun`. Najpierw wznawiają wstrzymane panele. Potem każdy aktywny run, którego nic nie niesie, dostaje to, co go niosło: sesję dyrygenta, jeśli ją miał i się nie zakończyła, inaczej napęd w tle (np. run systemowy na `status`). Run eskalowany jest pomijany z podpowiedzią. Każdy krok trafia do aktywności runu (`continued by <kto>: …`). `POST /panes/:pane/continue { by }` wznawia jeden wstrzymany panel. Panel, który nie jest wstrzymany, dostaje 400 `TRANSITION_DENIED`. Bez demona `metator run continue` napędza run jak dotąd.
- **Polecenie w pytaniu.** Pytanie o zgodę hosta (pytanie runu, Question v4, i pytanie panelu) ma `command`: całe polecenie spomiędzy przerywanych linii, bez wcięcia i ramki, z wierszami zawiniętymi przez terminal sklejonymi, a prawdziwymi łamaniami zachowanymi. `prompt` zaczyna się od pierwszego wiersza polecenia.
- **Czat wie, co się stało z zadaniem.** Gdy run uruchomiony z czatu (`startedRun`) się skończy, zostanie przerwany, eskaluje albo czeka na zatwierdzenie osoby, demon wpisuje do agenta w czacie jedną linię jako nową wiadomość (`ChatNotices`, droga `nudge` nadzorcy: słowa, potem Enter osobnym zapisem). Na przykład `[metator] The task <id> (<tytuł>) is done. Tell the person what was done.` Demon robi to tylko wtedy, gdy agent jest bezczynny; inaczej linia czeka. Każde zdarzenie jest zgłaszane raz i zapisywane w aktywności runu (`told the chat (pane <id>, <zdarzenie>)`).

## Konsekwencje
- Zatrzymanie i ponowne uruchomienie demona nie gubi sesji ani ekranów. Robotnicy wracają w swoich panelach z kontekstem sesji hosta.
- Proces hosta zabity z zewnątrz w czasie pracy (OOM, `kill`) jest wstrzymany i nadzorca albo „Continue” go wznowi. Host, który zakończył się sam, nie jest wznawiany.
- Layout ma wersję 4, a Question wersję 4. Starsze pliki wczytują się bez zmian.
- Linia w czacie jest wiadomością do agenta. Agent czatu powinien ją przekazać osobie, a nie traktować jako polecenia.

## Alternatywy odrzucone
- **Oznaczać zakończenie tylko po kodzie wyjścia, bez wiedzy o zatrzymaniu.** SIGHUP przy zatrzymaniu demona wygląda jak każde inne wyjście sygnałem. Demon wie, że się zatrzymuje, więc mówi to wprost.
- **Uruchamiać nowe sesje zamiast wznawiać.** Tak było: puste ekrany, praca robotników tracona.
- **„Continue” po stronie aplikacji (wiele wywołań).** Aplikacja nie zna dzieci w innych repozytoriach ani tego, co niosło run. Robi to rdzeń (`ContinueTask`), raz, dla wszystkich frontów.

## Implikacje dla kodu
Decyzję egzekwują MT-CODE-003 (Layout v4, Question v4 z migracjami i zamrożonymi schematami) i MT-TEST-003 (mutanty: `panes.ts`, `pty-broker.ts`, `continue-task.ts`, `chat-notices.ts`, `host-manifest.ts`, `node-pty-terminal.ts`).

- `packages/core/src/domain/layout.ts`: `paused`, `PANE_PAUSE_REASONS`.
- `packages/core/src/application/panes.ts`: `pauseAll`, `pause`, `saveScreens`, `resumePane`, `continuePane`, `restore(…, { resume })`.
- `packages/core/src/application/continue-task.ts`: `ContinueTask`, `TaskRepository`; `chat-notices.ts`: `ChatNotices`; `resume-notices.ts`: `ResumeNotices`, `resumeLine`.
- `packages/core/src/domain/host-manifest.ts`: `command` z `readHostPrompt`.
- `packages/plugin-node/src/node-pty-terminal.ts`: wyjście sygnałem jako 128 + sygnał.
- `packages/cli/src/serve/`: `--no-restore`, `--screens-ms`, `POST /runs/:run/continue`, `POST /panes/:pane/continue`; `commands/drive.ts`: `metator run continue`.
