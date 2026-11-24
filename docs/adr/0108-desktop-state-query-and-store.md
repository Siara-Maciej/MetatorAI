# ADR-0108: Stan aplikacji desktopowej: TanStack Query dla danych demona, store z wąskimi subskrypcjami

- Status: Proposed
- Data: 2026-11-24

## Kontekst
Aplikacja (ADR-0078) trzymała wszystko, co wie o demonie, w jednym kontekście Reacta o ok. 45 polach (`DaemonProvider`). Jego wartość powstawała od nowa przy każdym renderze, a `usePolled` po każdej odpowiedzi ustawiał nowy obiekt, także gdy odpowiedź była taka sama. Układ paneli jest czytany co sekundę, więc każdy z 56 odbiorców `useDaemon()` (40 plików) rysował się od nowa co sekundę, choć nic się nie zmieniło. Pomiar na bezczynnej aplikacji (Home, jeden demon, 20 s): 38 commitów Reacta.

Właściciel zdecydował (analiza z 2026-11-24): refaktoryzacja frontendu pod wydajność, z bibliotekami zamiast własnego kodu ogólnego (ADR-0010): TanStack Query, Zustand, Zod na granicy, React Compiler, komponenty shadcn/ui jako baza design systemu, struktura katalogów według funkcji (feature-based); bez RxJS i bez Effect. Ten ADR obejmuje pierwszy krok: warstwę stanu. Kolejne kroki dostaną własne ADR-y.

## Decyzja
1. **Dane demona to stan serwera w jednym cache zapytań** (`@tanstack/react-query`, `src/query.ts`). Żądanie powtarzane co interwał (`usePolled`) jest zapytaniem o kluczu `["polled", <adres demona>, <klucz>]`. Koperta z odmową albo bez danych jest błędem zapytania; dane, które były, zostają. Odpowiedź równa poprzedniej zachowuje obiekty poprzedniej (structural sharing), więc nic, co ją pokazuje, nie rysuje się ponownie. Demon jest na tym samym komputerze: zapytania nie czekają na „online" przeglądarki, nie są powtarzane po odmowie ani po powrocie fokusu, a interwał działa także w tle.
2. **Stan demona jest w store, nie w wartości kontekstu** (`zustand`, `src/daemon-store.ts`). `useDaemon("client", "repo")` nazywa pola, które czyta, i rysuje się ponownie tylko wtedy, gdy któreś z nich się zmieniło. Publikowany stan jest współdzielony strukturalnie z poprzednim: run, który się nie zmienił, to ten sam obiekt. Funkcje w stanie (`run`, `panesOf`, `planStepsOf`…) są te same, dopóki nie zmieni się to, z czego czytają.
3. **Stan z gniazd (`/ws/state`, `/ws/inbox`) też jest współdzielony strukturalnie** z poprzednim komunikatem.
4. **Testy komponentów** używają `@happy-dom/global-registrator` (DOM w `bun test`, rejestrowany i wyrejestrowywany w obrębie jednego `describe`).

## Stan realizacji
- Zrobione: punkty 1–4; `DaemonProvider` nadal składa stan (gniazda, cztery zapytania, autostart, dialog imienia) i publikuje go do store.
- Następne kroki (osobne ADR-y): podział `DaemonProvider` na części według funkcji i selektory na jeden run; struktura feature-based; Tailwind i shadcn/ui jako warstwa `ui/`; React Compiler; kanał zdarzeń `/ws/events` w demonie zamiast interwałów (interwał zostaje trybem awaryjnym).

## Konsekwencje
### Pozytywne
- Bezczynna aplikacja nie renderuje: ten sam pomiar po zmianie daje 0 commitów Reacta w 20 s (było 38).
- Dwa komponenty z tym samym kluczem dzielą jedno żądanie; powrót na ekran pokazuje ostatnie dane od razu i odświeża je w tle.
- Kanał zdarzeń z demona będzie mógł unieważniać zapytania po kluczu bez zmian w komponentach.

### Negatywne
- Dwie nowe zależności w paczce aplikacji i jedna testowa.
- Ekran może przez chwilę pokazać dane z cache (do 5 minut stare), zanim przyjdzie świeża odpowiedź; wcześniej pokazywał pusty stan.
- Store jest zasilany w efekcie po renderze `DaemonProvider`: to krok przejściowy, do podziału providera.

## Alternatywy odrzucone
- **Tylko `useMemo` na wartości kontekstu**: kontekst nie ma selektorów, każda zmiana jednego pola nadal rysuje wszystkich odbiorców.
- **Własny store na `useSyncExternalStore` i własne porównywanie odpowiedzi**: kod ogólny, który istnieje w sprawdzonych pakietach (ADR-0010).
- **RxJS, Effect**: drugi model reaktywności i błędów obok Reacta, `neverthrow` i XState; decyzja właściciela: nie.

## Implikacje dla kodu
- `packages/desktop/src/query.ts`, `packages/desktop/src/daemon-store.ts`, `packages/desktop/src/daemon.tsx` (`useDaemon(...pola)`, `usePolled`).
- Testy: `packages/desktop/test/state.test.tsx`; mutanty w `scripts/mutants.ts`.
- Rejestr zależności: `@tanstack/react-query`, `zustand`, `@happy-dom/global-registrator`.
