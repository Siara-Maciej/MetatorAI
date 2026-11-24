# ADR-0109: Aplikacja desktopowa: struktura według funkcji, warstwy zależności, React Compiler i granice błędów

- Status: Proposed
- Data: 2026-11-24

## Kontekst
`packages/desktop/src` rosło warstwami technicznymi: `components/` (43 pliki), `screens/` (13), `run/`, `overview/` i ok. 20 modułów w korzeniu, w tym `model.ts` (2595 linii logiki widoku wszystkich ekranów) i `hooks.ts`. O tym, do której części aplikacji należy plik, mówiła tylko jego nazwa, a nic nie pilnowało kierunku zależności (wspólny `hooks.ts` sięgał do kontekstu repozytoriów, komponenty wspólne do modelu ekranów).

Właściciel zdecydował (analiza z 2026-11-24): struktura kodu według funkcji (feature-based), kod czysty, zgodny z SOLID i DRY, warstwy pilnowane jak w reszcie repozytorium (reguły ast-grep).

## Decyzja
1. **Cztery warstwy w `src/`, zależności tylko w jedną stronę**: `app/` → `features/<nazwa>/` → `shared/` → `ui/`.
   - `ui/`: system projektowy, komponenty bez wiedzy o aplikacji (`Modal`, `Tabs`, `ListDetail`, `ContextMenu`, `Notice`).
   - `shared/`: to, czego używa wiele funkcji: `api/` (klient demona, cache zapytań), `daemon/` (stan demona, start demona), `platform/` (komendy Tauri, ich atrapa, powiadomienia), `model/` (wspólna logika widoku: trasy, klawisze, wygląd stanów, formatowanie, panele, kolejka potrzeb, plany systemowe, miejsca, zadania, wątki), `components/` (wspólne elementy znające model: `Glyph`, `StageBar`, `RepoSelect`…), `hooks.ts`.
   - `features/`: `inbox`, `runs`, `plans`, `terminals`, `threads`, `board`, `backlog`, `reviews`, `repos`, `system`, `settings`. Funkcja ma ekran `<nazwa>-screen.tsx` (wzorzec `desktop-screen`), swoje części i swój `model.ts` (czysty, testowany).
   - `app/`: powłoka (trasa → ekran, sidebar, pomoc, panel „brak demona”) i jej własna logika (`app/model.ts`).
2. **Reguły E1**: `mt-arch-desktop-layers-ui`, `-shared`, `-features` (i ich warianty `-tsx`) odrzucają import, re-eksport i `import()` w złą stronę (MT-ARCH-011..013).
3. **Funkcja importuje pliki innej funkcji wprost, bez plików `index.ts`.** Barrel wiązałby funkcje, które używają się nawzajem (karta decyzji z `inbox` w stronie runu, plany w karcie decyzji), w cykle importów, które `bun run arch` odrzuca (MT-ARCH-009); bezpośrednie importy zostawiają graf plików bez cykli.
4. **Logika widoku zostaje czysta i testowana**: `model.ts` podzielony według tego, kto go używa; nic nie zmieniło zachowania (te same testy, te same mutanty pod nowymi ścieżkami).
5. **React Compiler** (`babel-plugin-react-compiler` we wtyczce React Vite) memoizuje komponenty i hooki zamiast ręcznych `useMemo`, `useCallback` i `memo`. Kompilator pomija po cichu funkcję, której nie umie bezpiecznie skompilować, więc test (`test/compiler.test.ts`) kompiluje każdy plik `src/` i wymaga, by każdy komponent i hook się skompilował. Kod pisany pod kompilator: ref zmienia się w efekcie, nie w renderze (`useLatest` w `shared/hooks.ts`); nawigacja to jedna funkcja `navigate(route)` (`shared/navigation.ts`) zamiast przypisań do `window.location.hash` w komponentach.
6. **Granice błędów** (`react-error-boundary`): wyjątek w jednym ekranie pokazuje panel błędu w miejscu ekranu (z przyciskiem „Try again”, a przy zmianie trasy granica zaczyna od nowa), a powłoka i sidebar działają dalej. Wcześniej wyjątek w dowolnym komponencie zostawiał puste okno.

## Stan realizacji
- Zrobione: punkty 1–4. Podział zrobiony narzędziem (symbol → plik, importy przeliczone), bez zmian w ciałach funkcji.
- Zrobione: punkty 5–6.
- Następne kroki: podział `DaemonProvider`; system projektowy na shadcn/ui (osobny ADR); rozbicie dużych komponentów.

## Konsekwencje
### Pozytywne
- Plik funkcji znajduje się po nazwie funkcji; zmiana w jednej funkcji dotyka jej katalogu.
- `shared/` i `ui/` nie mogą zależeć od ekranów, więc da się je testować i przenosić osobno.

### Negatywne
- Importy między funkcjami prowadzą do konkretnych plików, nie do publicznego API funkcji; granica funkcji to konwencja, a nie reguła.
- Ścieżki się wydłużyły (`../../shared/model/look.ts`).
- Build przechodzi przez Babel (kompilator), co wydłuża go o kilka sekund.

## Alternatywy odrzucone
- **`index.ts` jako publiczne API każdej funkcji**: cykle importów między `inbox`, `runs` i `plans` (MT-ARCH-009).
- **Aliasy ścieżek (`@/shared/...`)**: kolejny mechanizm rozwiązywania modułów w Vite, `tsc`, `bun test` i grafie importów MetatorAI, dla samej długości ścieżek.
- **Ręczna memoizacja (`memo`, `useMemo`, `useCallback`) zamiast kompilatora**: łatwo o brakującą zależność albo zbędną barierę; kompilator robi to samo z analizy kodu.
- **Zostawienie `model.ts` w całości w `shared/`**: logika jednego ekranu (workbench, graf zależności, Home) byłaby dalej wspólna dla wszystkich.

## Implikacje dla kodu
- `packages/desktop/src/{app,features,shared,ui}/`; `rules/architecture/mt-arch-desktop-layers-*.yml` z testami w `rules/architecture-tests/`; MT-ARCH-011..013 w `docs/metator/rules/arch.yml`.
- Wzorzec `desktop-screen`: `packages/desktop/src/features/*/*-screen.tsx`.
- `packages/desktop/vite.config.ts` (kompilator), `packages/desktop/test/compiler.test.ts`, `packages/desktop/src/app/screen-boundary.tsx`; rejestr zależności: `babel-plugin-react-compiler`, `@babel/core`, `react-error-boundary`.
