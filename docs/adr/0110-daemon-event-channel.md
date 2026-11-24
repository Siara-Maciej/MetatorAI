# ADR-0110: Kanał zdarzeń demona: `/ws/events` mówi, które tematy się zmieniły

- Status: Proposed
- Data: 2026-11-24

## Kontekst
Aplikacja desktopowa odpytuje demona (`metator serve`) w pętli: stan, inbox, układ paneli, wątki, Backlog, plany. Każdy widok ma własny zegar, więc zmiana dociera z opóźnieniem jednego interwału, a demon liczy te same odpowiedzi wiele razy na sekundę, także gdy nic się nie zmieniło. Gniazda `/ws/state` i `/ws/inbox` (ADR-0076, ADR-0077) wysyłają całe dane, ale każde gniazdo miało własny `setInterval` i liczyło przegląd osobno.

Zmiany mają trzy źródła: żądania, na które demon sam odpowiada (POST, PUT); zegary demona (supervisor, intake, recenzje, sprzątanie paneli) i broker PTY w jego procesie; oraz **inne procesy**, które piszą pod `<repo>/.metator/` (`metator run drive --detach`, agenci wołający CLI). O tych ostatnich demon nie dowie się z własnych tras.

Właściciel odrzucił RxJS i Effect: zwykły TypeScript, bez nowej zależności.

## Decyzja
### 1. Jeden kanał: powiadomienie, nigdy dane
`/ws/events` to jedno gniazdo dla całego demona. Mówi tylko, **które tematy się zmieniły**; klient czyta je ponownie przez istniejące endpointy GET. Żaden kontrakt nie zmienia się: `/ws/state`, `/ws/inbox`, `/ws/activity`, `/ws/pty`, `/ws/pane` zostają, jak są (ADR-0076). Filtr `?repo=` nie jest potrzebny: gniazdo dostaje wszystkie tematy.

Wiadomości:
- po połączeniu `{ "type": "hello", "epoch": "<uuid>", "seq": <n> }` — `epoch` jest losowy przy każdym starcie demona, `seq` to numer ostatniej wysłanej zmiany (0: jeszcze żadnej);
- potem `{ "type": "changed", "epoch": "<uuid>", "seq": <n+1>, "topics": ["inbox", "state"] }` — tematy posortowane, każdy raz; `seq` rośnie o 1 na wiadomość, także gdy nikt nie słucha.

Klient po każdym `hello` czyta ponownie wszystko, co pokazuje (mógł coś przegapić, gdy był rozłączony; inny `epoch` to nowy demon). Temat może przyjść dla zmiany, którą klient już przeczytał (dwa źródła zobaczyły to samo): ponowne czytanie jest zawsze bezpieczne.

### 2. Tematy (jedno miejsce: `TOPICS` w `packages/cli/src/serve/events.ts`)
| Temat | Co przeczytać | Zakres |
|-------|---------------|--------|
| `state` | `GET /state`: przebiegi, pytania, etapy, liczba scratch, znacznik wątków | demon |
| `inbox` | `GET /inbox` | demon |
| `layout` | `GET /layout`: obszary robocze, karty, panele i stan każdego panelu (pyta, pracuje, bezczynny, zakończony) | repozytorium |
| `threads` | `GET /threads` | demon |
| `options` | `GET /options` | repozytorium |
| `plans` | `GET /system/plans`, `GET /runs/<run>/plan`, `GET /system/map` | repozytorium |
| `reviews` | `GET /reviews`, `GET /mrs` | demon |
| `backlog` | `GET /issues` | repozytorium |
| `activity:<runId>` | `GET /runs/<runId>/activity` | repozytorium |

Forma: nazwa, dla `activity` z przebiegiem po dwukropku. W demonie, który obsługuje folder, temat o zakresie repozytorium niesie nazwę checkoutu po `@`: `layout@shop`, `activity:<runId>@shop`. Demon jednego repozytorium nigdy nie dodaje `@`; temat o zakresie demona (jego endpoint obejmuje wszystkie repozytoria) też nie.

### 3. Hub: zbieranie w oknie 50 ms
`createEventHub` (czysty moduł, wstrzykiwany zegar): `publish(topics)` zbiera tematy; pierwsza publikacja planuje wysyłkę po `COALESCE_MS` (50 ms); wszystko, co przyjdzie w tym oknie, idzie jedną wiadomością. Seria zmian po jednym żądaniu to jedna wiadomość, nie dziesięć.

### 4. Źródła
- **Żądania:** dispatcher mówi o każdym żądaniu innym niż GET po odpowiedzi handlera (`answered`), a tabela `ROUTE_TOPICS` (`route-topics.ts`) mapuje wzorzec trasy na tematy (np. `/runs/:run/*` → `state`, `inbox`, `layout`, `activity:<run>`; `/panes/*` → `layout`; `/threads/*` → `threads`, `layout`, `state`; `/options/*` → `options`; `/system/*` → `plans`, `state`, `inbox`; `/reviews/*`, `/mrs/*` → `reviews`, `inbox`, `state`, `layout`; `/issues/*` → `backlog`, a `analyze|plan|start` także `state`, `inbox`, `layout`). Trasa bez wiersza publikuje `state`, `inbox`, `layout`; test pilnuje, że każda trasa demona, która coś zmienia, ma własny wiersz.
- **Zegary demona:** `TimerDeps.changed`; tik supervisora, który coś zrobił (`supervisorTopics`), przebieg z intake albo z recenzji, nowości obserwowanych MR, zakończone panele, powiadomienia czatu, fakty wątków, poczta paneli, wznowienia.
- **Broker PTY:** `PtyBroker.watch` (nowe w core) mówi o starcie panelu, pierwszym wyjściu po bezczynności, bezczynności, wyjściu procesu i zamknięciu — nigdy o samym wyjściu. To `layout`, a dla panelu przebiegu także `state` i `activity:<run>`. Zamknięty panel nie zgłasza „exited" po własnym zabiciu.
- **Inne procesy:** jeden wspólny przegląd (`createSweep`, `sweep.ts`) na cały demon, co `pollMs`: czyta tekst `state` i `inbox` (te same co gniazda, przez pamięć `overviewOf`), podpis układu każdego repozytorium (`layoutSignature`: bez znaczników czasu wyjścia i sekund ciszy, z pytaniem zablokowanego panelu) i znaczniki wątków. Tekst inny niż w poprzednim przeglądzie to zmieniony temat. Przegląd działa tylko, gdy coś go trzyma (gniazdo `events`, `state` albo `inbox`); pierwszy przegląd po starcie tylko się uczy.
- `/ws/state` i `/ws/inbox` nie mają już własnych zegarów: wysyłają bieżący tekst przy połączeniu, potem każdy inny tekst, który przeczyta wspólny przegląd. Zachowanie dla klienta jest takie samo.

### 5. Bez `fs.watch`
`fs.watch` na `<repo>/.metator/` nie jest użyty. Na Linuksie inotify sam nie obserwuje podkatalogów (rekurencję robi środowisko uruchomieniowe, a katalogi przebiegów powstają i znikają), zapisy atomowe (zapis do pliku tymczasowego i `rename`) dają serie zdarzeń, a kontenery i systemy plików sieciowe gubią zdarzenia; i tak potrzebny byłby przegląd jako siatka bezpieczeństwa. Przegląd co `pollMs` (domyślnie 1 s) jest prosty, deterministyczny i sprawdzony w e2e.

## Stan realizacji
- Zrobione: hub, tematy, tabela tras, źródła (żądania, zegary, broker PTY, wspólny przegląd), gniazdo `/ws/events`, `/ws/state` i `/ws/inbox` na wspólnym przeglądzie; testy jednostkowe (`packages/cli/test/serve-events.test.ts`, `packages/core/test/pty-broker.test.ts`), e2e (`e2e/serve-events.e2e.test.ts`), mutanty.
- Zrobione też: klient w `packages/desktop` (`shared/api/events.ts`, `shared/daemon/events.ts`): wiadomość sprawdzona schematem Zod; po zmianie tuż po poprzedniej czytane są ponownie zapytania jej tematów, po luce w `seq` albo nowym `epoch` wszystkie. Zapytania tematów, które demon zgłasza po każdej zmianie, kto by jej nie zrobił (`layout`, `threads`, zbiór `SWEPT`), są przy żywym kanale odpytywane tylko awaryjnie (dziesięć razy rzadziej, co najmniej co 30 s); pozostałe zachowują swój interwał, bo zmian planów, opcji i Backlogu wprowadzonych przez inne procesy demon nie przegląda. Demon bez kanału (trzy nieudane próby bez `hello`) nie jest pytany ponownie. Dowód: `e2e/desktop-push.e2e.test.ts`.
- Nie zrobione: przegląd planów, opcji i Backlogu zmienianych przez inne procesy; dopóki go nie ma, te tematy dochodzą przez `state`, gdy zmieniają przebieg, przy następnym `hello` albo przez interwał klienta.

## Konsekwencje
### Pozytywne
- Aplikacja może przestać odpytywać: czyta tylko to, co się zmieniło, zaraz po zmianie (50 ms zamiast interwału).
- Demon liczy przegląd raz na interwał, nie raz na gniazdo.
- Wiadomość nie niesie danych: kontrakt odpowiedzi zostaje w endpointach GET, kanał nie jest drugim API do utrzymania.

### Negatywne
- Zmiany innych procesów nadal docierają z opóźnieniem do `pollMs`.
- Temat może przyjść dwa razy dla jednej zmiany (trasa i przegląd); klient czyta wtedy dwa razy.
- Nowa trasa bez wiersza w tabeli publikuje szeroko, dopóki ktoś nie doda jej wiersza (test to wskazuje).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Dane w wiadomości (stan, układ) | drugi kontrakt do wersjonowania; duże wiadomości przy każdej zmianie |
| Gniazdo na temat albo na repozytorium | więcej połączeń i stanu w kliencie; tematy są zgrubne i tanie |
| RxJS albo Effect | odrzucone przez właściciela; hub to kilkadziesiąt linii zwykłego TypeScriptu |
| `fs.watch` / inotify jako główne źródło | zawodne dla zapisów atomowych i w kontenerach; przegląd i tak potrzebny |
| Przegląd na gniazdo (jak dotąd) | koszt rośnie z liczbą klientów |
| Server-Sent Events | demon ma już WebSockety; drugi mechanizm bez zysku |

## Implikacje dla kodu
- `packages/cli/src/serve/events.ts` (`TOPICS`, `topic`, `createEventHub`, `COALESCE_MS`), `route-topics.ts` (`ROUTE_TOPICS`, `routeTopics`, `paneTopics`, `UNKNOWN_ROUTE`), `sweep.ts` (`createSweep`, `layoutSignature`).
- `http.ts`: `Dispatch.answered`; `sockets.ts`: rodzaj `events`, `state` i `inbox` przez `sweep.listen`; `timers.ts`: `TimerDeps.changed`, `topicsOf`, `supervisorTopics`; `server.ts`: hub, przegląd, obserwacja brokera każdego kontenera.
- `packages/core/src/application/pty-broker.ts`: `PtyBroker.watch`, `PaneChange`.
- Dokumentacja użytkownika: `site/reference/http.md` (WebSockets).
