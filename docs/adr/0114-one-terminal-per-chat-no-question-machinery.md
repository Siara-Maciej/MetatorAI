# ADR-0114: Jeden terminal na czat, rozmowa zamiast pytań i kart

- Status: Proposed
- Data: 2026-11-27

## Kontekst
Właściciel produktu pracuje głównie w terminalu i 2026-11-27 ocenił obecny model jako zbędnie złożony:

- Pytania mają trzy drogi (karta na Home, `metator run ask`/`run answer`, terminal), a detektor pytań prozą (`agent-question.ts`) zgaduje z ekranu, czy agent pyta. Zgadywanie myli się (powitanie „Co robimy?” było pytaniem, ADR-0113).
- Run otwiera własny terminal dyrygenta, a dyrygent otwiera panel na każdego robotnika (ADR-0080, tryb „conductor”). Osoba nie chce oglądać terminali subagentów: ma rozmawiać z jednym agentem tak, jak w zwykłej sesji CLI.
- Pasek boczny pokazuje czat → zadania → repozytoria → kroki → panele. Przy jednym terminalu na czat ta hierarchia nic nie wnosi.

Decyzje właściciela (zebrane w tej sesji): bramki w rozmowie z agentem; każdy run ma żywy terminal (bez drive bez terminala w aplikacji); pasek boczny to czaty; „czeka na Ciebie” to odznaka czytana ze stanu terminala, a klik w wiersz fokusuje ten czat; terminale subagentów nie są pokazywane, jeden terminal obsługuje całość.

ADR-0113 jest pierwszym krokiem (pytanie terminala bez karty). Ten ADR opisuje stan docelowy i zastępuje ADR-0113 tam, gdzie mówi o detektorze i o kartach, które zostają.

## Decyzja
1. **Jeden terminal na czat.** Czat (`mt-chat`) sam prowadzi run w swoim terminalu: etapy deleguje natywnym subagentom hosta (jak `mt-orchestrator` poza trybem „conductor”), nie panelom. `metator run start` nie otwiera terminala dyrygenta dla runu z czatu; tryb „conductor” z panelami robotników (`run delegate`/`wait`/`collect`) znika z definicji agentów i z aplikacji.
2. **Pytanie to zdanie w rozmowie.** Agent pyta prozą w swoim terminalu i kończy turę. Definicje agentów, skille (`mt-grill`) i prompty z rdzenia (`conductor.ts`) nie każą używać `metator run ask`. Detektor `agentQuestionOf`, `PaneQuestions`, pytania panelu w `/inbox` i `POST /panes/:pane/answer` są usuwane.
3. **Bramka w rozmowie.** Na bramce agent pokazuje to, co jest zatwierdzane (plan, dostawa), i pyta. Słowo osoby w czacie jest zgodą na jedno `metator run approve <gate> --by <osoba>` albo `run advance fail --reason`, tak jak słowo w czacie jest dziś zgodą na commit (strażnik, `guard.consentMinutes`). Pytanie agenta, jego własne słowa i linie `[metator]` nie są zgodą. Karta decyzji i Home jako kolejka kart znikają.
4. **Prompt zgody hosta zostaje promptem hosta.** Okno zgody Claude Code jest w terminalu i tam dostaje odpowiedź; nie staje się pytaniem runu.
5. **Odznaka ze stanu terminala.** Czat „czeka na Ciebie”, gdy agent w jego terminalu skończył turę i stoi przy prompcie (`idle`) albo host pokazuje okno zgody (`blocked`); inaczej „working”. Źródłem jest sensor panelu (`paneStateOf`, manifest hosta), nie treść wiadomości. **Needs you** liczy takie czaty i prowadzi do następnego.
6. **Pasek boczny: czaty.** Jeden wiersz na czat: tytuł, odznaka, klik otwiera czat z klawiaturą w terminalu. Zadania, kroki i repozytoria są na Board; Terminals zostaje dla powłok.
7. **Bez drive bez terminala w aplikacji.** `metator run drive --detach` i host headless zostają poza aplikacją tylko wtedy, gdy etap 4 pokaże, że CI ich potrzebuje; inaczej są usuwane razem z `Question`, `run ask`, `run answer`, `AskInRun` i politykami odpowiedzi.

## Konsekwencje
- Jedna droga rozmowy i jedna droga decyzji: terminal czatu. Mniej kodu: detektor, pytania paneli, karty, inbox, tryb dyrygenta.
- Odznaka mówi „Twoja kolej” po każdej skończonej turze, także gdy agent tylko zdał raport. To jest zamierzone: tak wygląda rozmowa w CLI.
- Znika odpowiedź bez otwierania sesji; kryterium akceptacji 11a (`origin: inbox`, `docs/design/12-desktop.md`) trzeba zastąpić albo usunąć.
- Zgodę na bramkę wykonuje agent na słowo osoby. Strażnik musi odróżniać słowo osoby od tekstu agenta tak samo jak przy commicie; bez tego agent mógłby zatwierdzić własny plan.
- Robotnicy jako subagenci hosta nie mają własnego ekranu do podejrzenia; ich wynik to artefakty runu i podsumowanie w czacie.
- Zmiana cofa decyzje przyjętych ADR: 0037 (akceptacje), 0051 (`Question`, `run answer`, `waitFor`), 0052, 0088 (`run ask --wait`), oraz Proposed 0077, 0078, 0080, 0091, 0110 w częściach o inboxie i panelach robotników. Wymaga akceptacji człowieka przed wykonaniem.

## Etapy
1. **Zrobione (ADR-0113):** pytanie terminala bez karty, **Needs you** prowadzi do terminala.
2. **Agenci.** `mt-chat` prowadzi run sam z subagentami; pytania prozą; bramka na słowo osoby. Dowód: scenariusze hosta (`plugin-host-scenario`) i laboratorium zgodności.
3. **Aplikacja.** Pasek boczny z czatami i odznaką ze stanu terminala; **Needs you** z odznak; Home bez kart.
4. **Rdzeń i CLI.** Usunięcie detektora, `PaneQuestions`, `HostPrompts` w części pytań, `Question`/`run ask`/`run answer`, trybu dyrygenta; nadzorca nie szturcha agenta, który czeka na osobę. Około 61 plików testów jednostkowych i 45 e2e dotyka tych pojęć.

## Alternatywy odrzucone
- **Zostawić detektor i poprawiać heurystyki.** Każdy język i styl agenta to nowe wyjątki; stan terminala jest pewny.
- **Karty tylko dla bramek.** Druga droga decyzji obok terminala; właściciel wybrał rozmowę.
- **Panele robotników ukryte, ale żywe.** Zostaje cała maszyneria delegowania do paneli bez korzyści dla osoby.

## Implikacje dla kodu
- `metator/agents/mt-chat.md`, `mt-orchestrator.md`, `metator/skills/mt-grill/SKILL.md`, `packages/core/src/domain/conductor.ts`, `unprompted.ts` (lista dozwolonych).
- `packages/core/src/domain/agent-question.ts`, `application/pane-questions.ts`, `host-prompts.ts`, `ask-in-run.ts`, `run-journal.ts` (pytania), `drive.ts`, `supervisor.ts`; `packages/runtime/src/bootstrap.ts`.
- `packages/cli/src/commands/drive.ts` (`run ask`, `run answer`, `run questions`), `serve/routes/panes.ts`, `serve/server.ts` (`/inbox`).
- `packages/desktop/src/app/sidebar/`, `features/inbox/`, `shared/model/needs.ts`, `threads.ts`.
