# ADR-0089: Zmiany planu idą przez agenta

- Status: Accepted
- Data: 2026-11-18

## Kontekst
ADR-0087 dał osobie edytor planów w aplikacji (pola, tekst JSON, konflikty przez digest). Właściciel produktu go odrzucił: „po co mamy zmieniać pliki ręcznie? Agent powinien to robić; mówimy agentowi, co ma być inaczej, a on poprawia plan”. Do tego, żeby zobaczyć plan przy zatwierdzaniu, trzeba było kliknąć link: „plan powinien być zawsze widoczny domyślnie”.

Plan jest wynikiem pracy plannera (`mt-planner`, `mt-system-planner`), sprawdzanym bramkami (`plan lint`, `system plan lint`) i zatwierdzanym przez człowieka. Ręczna edycja omija plannera: jego kontekst (analiza, wzorce, reguły) nie widzi zmiany, a następny etap dostaje plan, którego nikt z agentów nie przemyślał.

## Decyzja
- **Plan jest tylko do odczytu w aplikacji.** Nie ma „Edit plan”, edytora pól, „Edit as text” ani trasy edycji; zakładka Plan pokazuje plan z lintem i plikami runu.
- **Plan w całości przy zatwierdzeniu.** Karta zatwierdzenia planu (bramka `hitl` po etapie, który pisze plan) pokazuje plan bez dodatkowego kliknięcia: kroki z plikami, testy pisane najpierw i na co każdy czeka; dla planu systemowego jego przepływ (fale, repozytoria, zależności) i kroki według repozytoriów.
- **Zmiany słowami.** Pod planem jest Approve i „Ask for changes” z polem tekstowym. Wysłanie to Reject bramki z tym tekstem jako powodem: run wraca do plannera (`onFail` bramki), który pisze nowy plan. Gdy lint blokuje Approve, karta mówi dlaczego i proponuje „Ask the planner to fix it” z problemami lintu w polu.
- **Widać, co się zmieniło.** Gdy planner napisał nową wersję, widok planu (`GET /runs/:run/plan`, `GET /system/plans/:plan`) podaje poprzednią (`previous: { plan, digest, at }`) i listę zmian według identyfikatorów kroków (`changes`), a karta i zakładka Plan je pokazują.
- **Mapa systemu zostaje edytowalna.** To konfiguracja osoby, nie wynik pracy agenta; ta decyzja jej nie dotyczy.

## Konsekwencje
- Każda zmiana planu przechodzi przez plannera i bramki; osoba nie może zapisać planu, którego żaden agent nie widział.
- Drobna poprawka kosztuje jedno przejście plannera zamiast jednego zapisu.
- Trasy zapisu planów (`PUT`) i dziennik `plan-edited` przestają być potrzebne aplikacji; backend może je usunąć.

## Alternatywy odrzucone
- **Edytor planów w aplikacji (ADR-0087).** Odrzucony przez właściciela: omija plannera i wymaga od osoby znajomości formatu planu.
- **Edycja z podpowiedzią agenta (osoba edytuje, agent sprawdza).** Nadal ręczna praca na pliku; ta sama wada.

## Implikacje dla kodu
Decyzję egzekwują reguły kanonu MT-TEST-003 (każdy nowy moduł z zachowaniem ma mutanta: `plan-flow.ts`, `confirm.ts`, `tasks.ts`) i MT-CODE-002 (poprzednia wersja planu i zmiany to pola wersjonowanych widoków, nie osobne pliki bez nagłówka).

- `packages/desktop/src/components/plan-approval-line.tsx`: `RunPlanFull`, `SystemPlanFull`, `AskForChanges`, `lintRequest`.
- `packages/desktop/src/components/plan-changes.tsx`: zmiany od poprzedniej wersji.
- `packages/desktop/src/run/plan-tab.tsx`, `components/system-plan.tsx`: plan tylko do odczytu.
- `packages/core/src/domain/plan-edit.ts`: pola `previous` i `changes` widoków planu.
