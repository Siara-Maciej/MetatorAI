# ADR-0091: Pytania paneli bez runu i ekran czytany tak, jak widzi go osoba

- Status: Proposed
- Data: 2026-11-20

## Kontekst
Prawdziwa sesja Claude Code w czacie wejścia (panel `role: apps`, agent `mt-orchestrator`, jeszcze bez runu) uruchomiła `metator workflow list`. Claude Code pokazał własne okno zgody („This command requires approval … 1. Yes / 2. Yes, and don't ask again for: metator workflow * / 3. … / 4. No”). Sensor oznaczył panel jako `blocked`, ale `/inbox` był pusty przez 30 minut. `HostPrompts.tick` pomijał każdy panel bez runu (`if (!pane.runId) continue;`), bo pytania żyły tylko w dzienniku runu. Aplikacja dodatkowo pokazywała zablokowany czat wejścia jako `idle`.

Drugi problem: `state.reason` zablokowanego panelu był surowym strumieniem bajtów. Zawierał kody ucieczki, tysiące `\r●` i klatki spinnera, bo sensor usuwał tylko sekwencje ANSI z całego zapisu wyjścia, a nie odtwarzał ekranu. Taki tekst trafiałby na karty i do paska bocznego.

## Decyzja
- **Pytanie panelu bez runu.** Prompt hosta (lub pytanie agenta `pytanie [a / b]`) w panelu bez runu staje się pytaniem panelu (`PaneQuestion`, `p001`…) w `PaneQuestions`. To magazyn w pamięci demona, jeden na repozytorium. Restart demona zadaje pytanie od nowa, bo ekran nadal je pokazuje, więc nie ma nowego dokumentu na dysku. `/inbox` ma obok `decisions` i `escalated` listę `panes`: `{ kind: "pane", repo?, paneId, label, role?, host, question: { id, paneId, source, agent, host, prompt, options, multiSelect, askedAt } }`. Odpowiedź osoby to `POST /panes/:pane/answer { question, choices, text?, by }`, tylko od osoby (`personOnly`). Pytania runów się nie zmieniają.
- **Menu hosta jako wybory.** Gdy ekran zablokowanego panelu ma numerowane menu (okno zgody Claude Code), opcjami pytania są pozycje menu oraz „Attach and answer in the pane” i „Leave it”. To dotyczy także paneli runów. Wybrana pozycja jest wpisywana do panelu jako jej numer, a Enter idzie osobnym zapisem (`PtyBroker.nudge`). Pytanie zamyka się, gdy znika z ekranu: odpowiedź z aplikacji albo z terminala (wtedy odpowiada `pane:<id>`). Zamknięty panel zabiera swoje pytanie ze skrzynki.
- **Ekran, nie bajty.** `PtyBroker` prowadzi dla każdego panelu `TextScreen` (`domain/screen.ts`): odtwarza to, co widać w terminalu, czyli ostatni rysunek każdej linii, ruchy kursora, kasowanie linii i ekranu, zawijanie i ekran alternatywny. Sensor czyta prompt z tego ekranu. `readHostPrompt` składa okno hosta w jedną linię, `<co>: <szczegół> — <dlaczego pyta>` (`Bash command: metator workflow list — This command requires approval`), z numerowanymi wyborami (`menu`). Powód jest ograniczony do 200 znaków. `metator pane read` i `GET /panes/:pane` też zwracają wyrenderowany ekran.
- **Aplikacja.** Home pokazuje pytanie panelu jako własną kartę (`PaneAskCard`): prompt, panel i repozytorium, wybory, Send oraz „Open the pane”. Adres karty to `#/inbox/pane/<repo>/<pane>/<question>`. Ramka panelu w Terminalach mówi „needs you”. Czat wejścia z promptem hosta na ekranie czyta się jako `asks`, a nie `idle`.

## Konsekwencje
- Osoba widzi w aplikacji, że czat czeka, i może odpowiedzieć bez przejmowania klawiatury.
- Pytania panelu nie przeżywają restartu demona, ale są zadawane ponownie, dopóki ekran je pokazuje. `metator inbox` w terminalu ich nie pokazuje, bo czyta repozytorium, a nie demona.
- Wybór z menu z aplikacji jest zgodą osoby na narzędzie hosta (np. polecenie Bash). Aplikacja wysyła go tylko pod nazwiskiem osoby, a agent w panelu nie może odpowiedzieć sam (403 dla tokenu panelu).

## Alternatywy odrzucone
- **Pytanie panelu jako pytanie runu z pustym `runId`.** Łamie wersjonowany dokument `Question` (`runId`, `stage` są wymagane) i jego miejsce na dysku (`.metator/runs/<id>/questions/`).
- **`@xterm/headless` jako model ekranu.** To sprawdzony pakiet (ADR-0010), z tej samej rodziny co terminal aplikacji (ADR-0078), i lepszy od własnego modelu (szerokie znaki, regiony przewijania). Dodanie zależności zostało w tej sesji zablokowane przez uprawnienia. `TextScreen` jest tymczasowym rozwiązaniem: jeśli osoba zatwierdzi zależność, można go zastąpić portem z adapterem w `plugin-node`, bez zmiany sensora.
- **Usuwanie samych kodów ANSI z linii.** Tak było; nie usuwa klatek rysowanych `\r` ani linii skasowanych kursorem.

## Implikacje dla kodu
Decyzję egzekwują MT-TEST-003 (mutanty: `screen.ts`, `readHostPrompt`, `PaneQuestions`, `HostPrompts`, `pane-sensor.ts`, `pty-broker.ts`, `desktop/src/model.ts`) i reguły architektury (`bun run arch`).

- `packages/core/src/domain/screen.ts`: `TextScreen`, `renderScreen`.
- `packages/core/src/domain/host-manifest.ts`: `readHostPrompt`, `REASON_MAX`, `PaneStateView.menu`.
- `packages/core/src/application/pane-questions.ts`: `PaneQuestions`, `PaneQuestion`.
- `packages/core/src/application/host-prompts.ts`: pytania paneli bez runu, `answerPane`, wybory z menu.
- `packages/cli/src/serve/routes/panes.ts`: `POST /panes/:pane/answer`; `packages/cli/src/serve/server.ts`: `/inbox` z `panes`.
- `packages/desktop/src/components/pane-ask-card.tsx`, `src/model.ts` (`needsQueue`, `paneAskKey`, `paneNeedsYou`, `paneStateOf`).
