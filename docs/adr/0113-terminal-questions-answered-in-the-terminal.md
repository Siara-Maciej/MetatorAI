# ADR-0113: Pytanie zadane w terminalu ma odpowiedź w terminalu, bez karty

- Status: Proposed
- Data: 2026-11-27

## Kontekst
ADR-0091 dał pytaniu panelu (prompt hosta albo pytanie agenta słowami) własną kartę na Home (`PaneAskCard`): prompt, wybory, Send, „Open the pane”. Osoba, która pracuje głównie w terminalu, dostawała przez to drugi sposób odpowiedzi na to samo pytanie. Licznik **Needs you** prowadził do widoku kart, a nie do terminala, w którym agent czeka. Karta powtarzała ekran panelu gorzej niż sam panel: dla pytania słowami miała często tylko „Other” i „Leave it”, a pełny tekst był zwinięty. Właściciel produktu ocenił ten widok jako nieużyteczny (2026-11-27) i chce, żeby aplikacja wskazywała terminal, w którym oczekiwana jest reakcja.

Drugi problem: powitanie czatu po polsku kończące się na „Co robimy?” było czytane jako pytanie agenta, bo wyjątek dla zaproszeń (`INVITATION` w `agent-question.ts`) znał tylko angielskie zwroty. Każdy nowy czat podnosił więc **Needs you** bez powodu.

## Decyzja
- **Bez karty dla pytań terminala.** Pytanie panelu (`kind: pane`) i run pytający na swoim terminalu (`terminal:`) nie mają karty na Home (`answersInTerminal`). Odpowiedź wpisuje się w terminalu, w którym pytanie stoi.
- **Needs you prowadzi do terminala.** Miejsce potrzeby liczy `needPlace`: czat, którego terminal pyta (`#/thread/<id>`), w innym razie zakładka Terminal runu na tym panelu, w innym razie panel w Terminals. Klik w **Needs you** idzie do następnej potrzeby po tej, która jest na ekranie (`nextNeed`), więc kolejne kliknięcia przechodzą po wszystkich czekających terminalach i kartach.
- **Home zostaje dla decyzji bez terminala.** Karty mają: bramka (akceptacja planu, dostawy), pytanie z `metator run ask`, prompt hosta w runie, run eskalowany, review (`cardNeeds`). Terminale, które pytają, są nad kartami jako lista po jednej linii; klik prowadzi do terminala. Home nie mówi „Nothing waits for you”, gdy jakiś terminal pyta.
- **Oznaczenie zostaje to samo.** Ramka panelu mówi „needs you”, wiersz czatu w pasku bocznym czyta się `needs you`. Zakładka Terminal runu pokazuje baner także wtedy, gdy pyta jego panel przez pytanie panelu (`askingPane`), a nie tylko przez `terminalAsk`.
- **Demon bez zmian.** `PaneQuestions`, `/inbox` z `panes` i `POST /panes/:pane/answer` zostają dla skryptów i CLI; aplikacja tego żądania już nie wysyła. Pytanie zamyka się, gdy znika z ekranu.
- **Zaproszenia po polsku.** `agentQuestionOf` nie czyta jako pytania zamykającego zaproszenia po polsku („Co robimy?”, „W czym mogę pomóc?”, „Od czego zaczynamy?”, „Coś jeszcze?”), tak jak angielskiego. Pytanie o konkret („Co robimy z tym testem?”) nadal jest pytaniem.

Zmienia to punkt „Aplikacja” z ADR-0091; reszta ADR-0091 zostaje.

## Konsekwencje
- Jedna droga odpowiedzi na pytanie z terminala: terminal. Licznik prowadzi tam, gdzie się odpowiada.
- Na panel runu trzeba najpierw wziąć klawiaturę (Attach); karta pozwalała odpowiedzieć bez tego. Baner zakładki Terminal mówi to wprost.
- Zgoda na commit w czacie nie ma już zdania „git commit needs your consent” z karty; osoba widzi prompt hosta w terminalu. Powód strażnika (`reason`) zostaje w `/inbox`, ale aplikacja go dla pytań panelu nie pokazuje.
- „Co robimy?” po raporcie o błędzie nie podniesie **Needs you**. Koszt jest mały: agent i tak czeka przy prompcie, a czat jest widoczny w pasku bocznym.

## Alternatywy odrzucone
- **Karta i terminal obok siebie (stan z ADR-0091).** Dwa sposoby odpowiedzi na jedno pytanie; karta gorsza od ekranu, który streszcza.
- **Automatyczne przejście do terminala, gdy tylko pyta.** Zabiera ekran w trakcie innej pracy; przejście zostaje aktem osoby (klik w **Needs you**).
- **Usunięcie Home.** Bramki, eskalacje i review nie mają terminala, w którym można odpowiedzieć.

## Implikacje dla kodu
Decyzję egzekwują MT-TEST-003 (mutanty `needs.ts`: `answersInTerminal`, `needPlace`, `nextNeed`; `agent-question.ts`: zaproszenie po polsku) i testy e2e aplikacji.

- `packages/desktop/src/shared/model/needs.ts`: `answersInTerminal`, `cardNeeds`, `needPlace`, `nextNeed`, `askingPane`.
- `packages/desktop/src/features/inbox/use-needs.ts`: `useNeedPlace`; `inbox-screen.tsx`: lista `terminal-asks`; usunięty `pane-ask-card.tsx` i `DaemonClient.answerPane`.
- `packages/desktop/src/app/sidebar/sidebar.tsx`: **Needs you** idzie do `nextNeed`.
- `packages/desktop/src/features/runs/terminal-tab.tsx`: baner z `askingPane`.
- `packages/core/src/domain/agent-question.ts`: `INVITATION_PL`.
- `e2e/desktop-pane-ask.e2e.test.ts`, `desktop-text-question.e2e.test.ts`, `desktop-stage1.e2e.test.ts`, `desktop.e2e.test.ts`.
