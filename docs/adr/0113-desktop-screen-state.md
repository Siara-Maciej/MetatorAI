# ADR-0113: Stan ekranów aplikacji desktopowej: store zustand na ekran, subskrypcje w małych komponentach

- Status: Proposed
- Data: 2026-11-27

## Kontekst
ADR-0108 przeniósł stan demona do store z wąskimi subskrypcjami, a dane demona do cache TanStack Query. Stan samych ekranów został w komponentach: 179 wywołań `useState`/`useReducer`/`useEffect`/`useRef` w `src/`, najwięcej w `workbench-screen.tsx` (21), `terminal-tab.tsx` (14), `new-session.tsx` (12), `doc-editor.tsx` (12). Backlog trzymał w jednym 458-liniowym komponencie siedem `useState` (wybrane zadanie, workflow, formularz, szkic, rozwinięcie listy, ponowienie startu) i stan akcji z `useAction`. Każda litera wpisana w tytuł nowego zadania i każde kliknięcie wiersza rysowały od nowa cały ekran: listę, szczegóły i przyciski. Właściciel zdecydował (2026-11-27): zustand jako store globalny i store na ekran, subskrypcje w możliwie małych komponentach.

## Decyzja
1. **Trzy rodzaje stanu, każdy w jednym miejscu.**
   - Dane demona to zapytania TanStack Query (ADR-0108).
   - Stan aplikacji to store'y zustand w module, poza Reactem: `shared/notice.ts`, `shared/overlays.ts`, `shared/daemon/session.ts`, stan demona.
   - Stan ekranu to store zustand tworzony na czas życia ekranu.
2. **Store ekranu: `scopedStore` i `<ScopeProvider>`** (`src/shared/state/scoped-store.ts`).
   - Ekran definiuje swój store raz, w `features/<ekran>/state.ts`: wartości i akcje razem, bez Reacta. Dostaje to, co ekran wie przy otwarciu: id z trasy i store demona.
   - Własne hooki ekran definiuje na poziomie modułu, np. `useBacklog(select)` i `useBacklogApi()`.
   - Dwie kopie ekranu mają dwa store'y. Store znika razem z ekranem, a ponowne narysowanie ekranu go nie odtwarza.
3. **Komponent subskrybuje jedną wartość, którą rysuje.**
   - Odczyt idzie przez selektor zwracający wartość prostą albo obiekt, który się nie zmienia.
   - Wiersz listy czyta własne zadanie i tylko to, czy jest wybrany (`useIsCurrent(id)`), więc zmiana wyboru rysuje dwa wiersze.
   - Pole formularza czyta własną część szkicu.
   - Obsługa zdarzenia czyta i zmienia store w chwili zdarzenia (`useBacklogApi().getState()`), bez subskrypcji.
   - Komponent ekranu tylko układa części i niczego nie subskrybuje.
4. **Dane demona też w kawałkach.** `usePolledSelect(key, fn, ms, select)` daje komponentowi tylko jego część odpowiedzi; TanStack Query trzyma wynik selektora, dopóki ten się nie zmieni. Komponenty z tym samym kluczem dzielą jedno żądanie. Akcja czyta zapytanie ponownie przez `readAgainNow(url, key)`, bez trzymania go w komponencie.
5. **Akcja w storze ekranu** (`src/shared/state/action.ts`): `busy` i komunikat odpowiedzi (`notice`) są polami store'u, więc rysują się tylko przycisk i komunikat. Imię osoby `runAction` czyta ze store'u demona w chwili akcji.
6. **Egzekwowanie:** reguła kanonu MT-ARCH-015 (E1, ast-grep) zabrania `useState` i `useReducer` w `app/`, `features/` i `shared/` poza `shared/state/`. Prymitywy `ui/` mogą mieć własny stan wewnętrzny.

## Stan realizacji
- Zrobione: punkty 1–6, na każdym ekranie aplikacji. Backlog był wzorcem. Za nim przeszły:
  - Terminals, karta terminala runu i czat;
  - strona runu, formularz nowego runu, Changes, plany, edytor dokumentu i mapy systemu, panele systemu;
  - Board, inbox i karty decyzji, przeglądy, ustawienia;
  - powłoka (trasa, pasek boczny, nakładki), dodawanie repozytoriów, stan demona i jego gniazda.
- `useAction` usunięty; `asAction` (`shared/state/action.ts`) daje akcję store'u ekranu kontrolkom, które biorą `Action` (`runControls`, `<StartRun>`).
- Reguła MT-ARCH-015 (`mt-arch-desktop-state`) w CI.
- Testy liczące rysowania (`<Profiler>`) dla gorących ścieżek każdego ekranu, na przykład:
  - pisanie w polu rysuje tylko to pole;
  - wybór wiersza rysuje dwa wiersze;
  - zmiana jednego runu rysuje tylko jego wiersz w pasku bocznym;
  - fokus panelu rysuje dwa kafelki.
- Widżety z własnym stanem chwilowym są prymitywami `ui/`: `Disclosure`, `CopyButton`, `CopyCommand`.

## Konsekwencje
### Pozytywne
- Wpisanie tytułu zadania i wybór wiersza nie rysują całego ekranu.
- Stan ekranu i jego akcje da się testować bez Reacta: store tworzy się z danych.
- Jeden wzorzec zamiast `useState` rozsianych po 458-liniowym komponencie.

### Negatywne
- Więcej małych komponentów i plików na ekran.
- Selektor zwracający nowy obiekt przy każdym wywołaniu rysuje komponent zawsze: selektory muszą zwracać wartości proste albo obiekty, które się nie zmieniają, i trzeba tego pilnować w przeglądzie.

## Alternatywy odrzucone
- **`useState` z `React.memo` i rozdzielonymi kontekstami:** każdy kontekst rysuje wszystkich odbiorców, a `memo` nie chroni przed zmianą własnego stanu rodzica.
- **Jeden globalny store na wszystkie ekrany:** stan ekranu żyłby dłużej niż ekran (stary szkic po powrocie), a dwie kopie ekranu dzieliłyby jeden stan.
- **Jotai lub Valtio:** drugi model stanu obok zustand, który aplikacja już ma (ADR-0108).
- **Fabryka zwracająca Provider i hooki (`createStore` z Context w jednej funkcji):** Biome (`noComponentHookFactories`) i React Compiler wymagają komponentów i hooków zdefiniowanych na poziomie modułu.

## Implikacje dla kodu
- `packages/desktop/src/shared/state/` (`scoped-store.ts`, `action.ts`), `usePolledSelect` i `readAgainNow` w `src/shared/daemon/daemon.tsx`, `usePolledSelectAt` i `readPolledAgain` w `src/shared/api/query.ts`.
- `packages/desktop/src/features/backlog/` jako wzorzec.
- ADR-0113 egzekwuje reguła kanonu MT-ARCH-015 (`metator rules show MT-ARCH-015`).
- Testy: `packages/desktop/test/screen-state.test.tsx`; mutanty w `scripts/mutants.ts`.
