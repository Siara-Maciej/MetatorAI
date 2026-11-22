# ADR-0096: Analiza i plan w Backlogu: na żądanie, ze świeżością według cytowanych plików

- Status: Proposed
- Data: 2026-11-21

## Kontekst
Decyzja właściciela produktu z rozmowy 2026-11-20/21, z dopowiedzeniami z 2026-11-21 (plan kroku, Backlog z dużego planu).

Stan dzisiejszy:
- Backlog to dokumenty `Issue` w `.metator/issues/` (`packages/core/src/domain/issue.ts`): tytuł, opis, status, priorytet, etykiety, odnośniki. Agent tylko proponuje (`metator issue propose`), zadanie powstaje po decyzji osoby; `metator issue start` uruchamia run. Zadanie nie ma analizy, planu ani dzieci. Ekran: `packages/desktop/src/screens/backlog.tsx`, trasy: `packages/cli/src/serve/routes/backlog.ts`.
- Analiza i plan powstają tylko w runie: `analysis.json` i `research.json` na etapie `context`, `plan.json` na etapie `plan`, sprawdzane przez `plan lint` (ADR-0035) i zatwierdzane przez osobę. Plan systemowy to `SystemAnalysis` i `SystemPlan` (ADR-0070). Poza runem planu nie ma.
- Pytanie w czacie wejścia kończy się odpowiedzią z cytatami `plik:linia` (`INTAKE_PROMPT` w `packages/core/src/application/panes.ts`); nic nie trafia do Backlogu.
- Deterministyczne źródła analizy już są: graf importów (`metator graph`), karty modułów (`docs/metator/modules/`, ADR-0022) i `metator similar` (ADR-0023).
- Plan jest w aplikacji tylko do odczytu, a zmiany idą przez agenta (ADR-0089). Graf planu systemowego (`packages/desktop/src/components/plan-flow-graph.tsx`) po kliknięciu kroku otwiera jego run potomny albo plan, gdy runu jeszcze nie ma. Tablica (`packages/desktop/src/screens/board.tsx`) pokazuje kroki zadania w kolumnach faz.
- Krok planu systemowego (`packages/core/src/domain/system-plan.ts`) ma aplikację, opis, kontrakty i zależności (`dependsOn`). Własnego planu nie ma, dopóki nie wystartuje jego run potomny.
- Nic nie mówi, czy analiza albo plan są jeszcze aktualne względem kodu.

## Decyzja
- **„Przeanalizuj”.** Wynikiem jest odpowiedź w czacie oraz zadanie w Backlogu z analizą. Analiza jest deterministyczna (graf, karty, `similar`) plus agent, który kosztuje limit.
- **Plan na żądanie.** Przycisk przy zadaniu w Backlogu robi sam plan, bez implementacji, z podglądem terminala agenta, który go robi.
- **Świeżość.** Analiza i plan są nieaktualne, gdy zmienił się którykolwiek cytowany plik albo pakiet, którego dotyczą. Czas (np. 14 dni) jest tylko ostrzeżeniem.
  - „Zrób plan” przy nieaktualnej analizie wymaga nowej analizy.
  - „Implementuj” przy świeżym planie startuje od razu.
  - „Implementuj” przy nieaktualnym planie zaczyna od przeglądu planu (plan review).
- **Plan kroku przed startem.** Przy dużym planie (fazy w wielu repozytoriach albo w jednym) kliknięcie kafla na grafie albo w Kanbanie pokazuje, co ten krok będzie robić. Kafel od razu pokazuje to, co jest w planie systemowym (cel, pliki, kontrakty, zależności), i ma przycisk „Zrób plan tego kroku”: na żądanie, z podglądem terminala agenta. Planista nie robi szczegółowych planów wszystkich kroków z góry.
- **„Utwórz z tego zadanie w Backlogu”.** Główny podgląd planu ma tę opcję: plan nieuruchomiony żyje w Backlogu, a nie tylko w wątku.
- **Backlog z dużego planu.** Powstaje zadanie nadrzędne z dziećmi, po jednym na fazę albo krok. Każde dziecko da się uruchomić osobno z pilnowaniem zależności: krok nie ruszy przed tymi, od których zależy.
- **Powiązanie z wątkiem.** Zadanie utworzone z planu jest powiązane z wątkiem, w którym plan powstał, i przeżywa jego zamknięcie: uruchomione otwiera nowy wątek. Zasadę zapisuje ADR-0095.
- **Wszystko na żądanie.** Agent może o to zapytać.

## Konsekwencje
- Analiza i plan przestają być własnością runu: mogą powstać wcześniej, poczekać w Backlogu i zostać uruchomione później albo wcale.
- Osoba nie płaci limitem za plany, których nie chce: szczegółowy plan kroku powstaje dopiero po kliknięciu.
- Świeżość liczona z cytowanych plików i pakietów jest deterministyczna, więc „Implementuj” na przestarzałym planie nie ruszy bez przeglądu.
- Zadanie Backlogu dostaje analizę, plan, dzieci i powiązanie z wątkiem. Dzisiejszy `Issue` tego nie ma, więc potrzebna jest nowa wersja albo nowe dokumenty.
- Pilnowanie zależności między dziećmi powtarza to, co `system plan run` robi dla kroków planu systemowego (ADR-0071); powinno użyć tej samej reguły, a nie drugiej.
- Plan dalej zmienia tylko agent (ADR-0089); przyciski uruchamiają agenta, a nie edytor.

## Zastępuje i rozszerza
- Rozszerza ADR-0089 (plan widoczny, zmiany przez agenta) o plan poza runem i plan kroku na żądanie.
- Rozszerza ADR-0070 i ADR-0071 (plan systemowy, runy powiązane) o uruchamianie pojedynczych kroków z Backlogu.
- Rozszerza ADR-0083 (wejście A): pytanie „przeanalizuj” zostawia zadanie w Backlogu.
- Niczego nie zastępuje w całości.

## Pytania otwarte
- Gdzie żyją analiza i plan zadania: pola nowej wersji `Issue` czy osobne dokumenty obok; który dokument planu (`Plan`, `SystemPlan`) obowiązuje poza runem?
- Czy zadanie z „Przeanalizuj” powstaje od razu jako otwarte, czy jako propozycja do decyzji osoby (dziś agent tylko proponuje)?
- Który agent robi analizę i plan na żądanie i czy jest to run zatrzymany po planie; jak „Implementuj” przejmuje gotowy plan (które etapy workflowu pomija)?
- Co zapisać, żeby wykryć zmianę: skróty cytowanych plików, commit, wersję pakietu? Jak wyznaczyć „pakiet, którego dotyczą”? Czy liczą się zmiany na innych gałęziach i w worktree?
- Wartość ostrzeżenia czasowego (np. 14 dni) i jej klucz w konfiguracji.
- „Plan review” przy nieaktualnym planie: `plan lint` i `mt-plan-critic`, przegląd osoby, czy jedno i drugie?
- Skąd kafel bierze „pliki” kroku: krok planu systemowego ma dziś opis, kontrakty i zależności, a listy plików nie.
- Dzieci „po jednym na fazę/krok”: kiedy faza, a kiedy krok? Czy zadanie nadrzędne zamyka się samo, gdy wszystkie dzieci są zrobione?
- Czy „Przeanalizuj” to tylko słowa w czacie, czy także przycisk?

## Implikacje dla kodu
Decyzję będą egzekwować MT-CODE-003 (analiza, plan, dzieci i powiązanie z wątkiem to nowa wersja `Issue` albo nowe dokumenty, z migracją i zamrożonym schematem), MT-TEST-003 (mutanty dla świeżości i dla pilnowania zależności) i MT-TEST-001 (e2e: zadanie z analizą, plan na żądanie, odmowa startu kroku przed jego zależnościami). Zmiany w kodzie czekają na akceptację. Analiza i plan w Backlogu dotkną:

- `packages/core/src/domain/issue.ts`, `packages/cli/src/commands/issue.ts`, `packages/cli/src/serve/routes/backlog.ts`.
- `packages/core/src/domain/system-plan.ts`, `packages/core/src/application/system-runs.ts`: kroki i ich zależności.
- `packages/core/src/application/panes.ts`: `INTAKE_PROMPT` (droga „przeanalizuj”).
- `packages/desktop/src/screens/backlog.tsx`, `packages/desktop/src/screens/board.tsx`, `packages/desktop/src/components/plan-flow-graph.tsx`.
