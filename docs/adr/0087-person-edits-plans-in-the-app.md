# ADR-0087: Osoba edytuje plany w aplikacji

- Status: Proposed
- Data: 2026-11-15

## Kontekst
Scenariusz na dwóch repozytoriach (`shop-api`, `shop-web`, host `scenario`) pokazał, że aplikacja desktopowa nie potrafi pokazać, zlintować, zatwierdzić ani **zmienić** planu: ani planu implementacji runu (`plan.json`), ani planu systemowego (`metator/system/plans/<id>.yml`). Nie pokazuje też plików runu (`plan.md`, `build-log.md`) i nie zapisuje mapy systemu. Zakładka Plan znała tylko artefakty `mt-feature` (defekt 10), więc run systemowy nie widział ani kroków planu systemowego, ani `plan.md`. Właściciel produktu: „musimy mieć podgląd planu i możliwość wprowadzania w nim zmian”.

Pliki planów są dokumentami wersjonowanymi (ADR-0016) i czytają je inne procesy: drive, dyrygent, hooki (`plan-scope.json`), bramki (`plan lint`, `system plan lint`). Edycja z aplikacji nie może więc ominąć schematu ani nadpisać zmiany zrobionej w międzyczasie przez agenta lub drugą osobę.

## Decyzja
- **Kto i co.** Plan zmienia osoba w aplikacji (każdy zapis niesie `by`, regułę `who()` z CLI). Wywołanie z panelu agenta (z tokenem `x-metator-pane`) jest odrzucane (403): agent pisze plik planu tam, gdzie każe jego etap.
- **Kiedy: plan runu.** Plan runu (`plan.json`) można zmieniać, dopóki run nie przeszedł bramki człowieka, która go zatwierdza: pierwszego etapu `hitl` po etapie produkującym `plan.json` (w `mt-feature` to `plan-approval`). Run eskalowany lub zatrzymany przed tą bramką też można. Później plan jest tylko do odczytu, a widok podaje powód (`readOnlyBecause`); zapis to `TRANSITION_DENIED`. Zapis odświeża `plan-scope.json`, jeśli run go ma, bo z niego hooki egzekwują zakres edycji.
- **Kiedy: plan systemowy.** Plan systemowy można zmieniać, dopóki nie jest `done`. Krok, który ma już run potomny, jest niezmienny (nie można go zmienić ani usunąć); nowe kroki można dodawać. Postęp (`status`, `run`) i zatwierdzenie należą do planu, nie do edytora: nowy krok jest `pending` bez runu, a zatwierdza się osobnym `approve` (lint musi być czysty, jak w `ApproveSystemPlan`).
- **Zatwierdzenie się starzeje.** Zmiana tego, co obejmuje zatwierdzenie (`systemPlanDigest`: zadanie, strategie, kroki), cofa plan systemowy do `draft` i usuwa zatwierdzenie; wpis w dzienniku mówi, czyje zatwierdzenie przepadło. Fale (kolejność wdrożeń) i lint liczone są na nowo z istniejących funkcji domeny (`systemPlanWaves`, `lintSystemPlan`).
- **Mapa systemu.** Mapę zmienia się tylko, gdy jest plikiem tego repozytorium; mapa przypięta w innym repozytorium jest tu tylko do odczytu. Odkrywanie (`POST /system/discover`) w folderze czyta wszystkie repozytoria i nigdy nie nadpisuje istniejącej mapy.
- **Współbieżność przez digest.** Widok każdego dokumentu podaje `digest` (FNV-1a kanonicznej treści, `documentDigest`). Zapis musi podać digest wersji, na której się opiera; inny niż bieżący to błąd `CONFLICT` (HTTP 409) z bieżącym widokiem w `details.current`, żeby aplikacja pokazała obie wersje. Nic nie jest zapisane.
- **Tylko poprawne dokumenty.** Treść jest sprawdzana schematem dokumentu przed zapisem (`documentFromBody`); niepasująca to `USAGE` z problemami według pola, nic nie jest zapisane. Błędy lintu nie blokują zapisu: są pokazywane, a bramki dalej ich pilnują.
- **Każda zmiana jest zapisana z autorem i opisem.** Plan runu: linia aktywności typu `plan-edited` („plan edited by ana: step added: S3”) — nowa wersja dokumentu `RunActivity` (v3). Plan systemowy i mapa: dziennik `<plik>.edits.jsonl` z dokumentami `PlanEdit` (kto, kiedy, digest przed i po, co się zmieniło według identyfikatorów kroków, aplikacji i kontraktów).
- **Pliki runu.** `GET /runs/:run/artifacts` pokazuje tylko pliki wewnątrz katalogu runu (bez `..`, ścieżek absolutnych i dowiązań wychodzących poza katalog), tylko znane rozszerzenia tekstowe (`.md .json .yml .yaml .txt .log`), do 512 KiB z flagą `truncated`. Pojęcia „prywatnego” pliku runu nie ma, więc decyduje lista rozszerzeń. Rozmiar, czas i cel dowiązania daje nowy port `FileStats`.

## Konsekwencje
- Aplikacja ma podgląd i edycję planu runu, planów systemowych i mapy oraz podgląd plików runu; zakładka Plan zna workflow runu i pokazuje plan systemowy (kroki według repozytoriów, fale, runy potomne).
- Edycja nie może wyprzedzić zatwierdzenia: plan po bramce jest zamrożony, a zmieniony plan systemowy trzeba zatwierdzić ponownie.
- Zapis mapy przez aplikację pisze YAML od nowa: komentarze ręcznie pisanej mapy giną (dziennik zmian zostaje).
- Dwa nowe dokumenty do utrzymania: `RunActivity` v3 i `PlanEdit` v1 (zamrożone schematy w `docs/metator/schemas`).

## Alternatywy odrzucone
- **Blokady zamiast digestu.** Agent i osoba pracują w różnych procesach i różnym tempie; blokada trzymana przez otwarty edytor blokowałaby drive. Digest nie blokuje nikogo i wykrywa konflikt dopiero przy zapisie.
- **Edycja przez terminal agenta.** Działa, ale nie daje podglądu lintu, fal ani konfliktów i nie zapisuje, kto co zmienił.
- **Pozwolić edytować kroki z runem.** Run potomny dostał już swoje zadanie; zmiana kroku po starcie rozjechałaby plan z tym, co robi run.

## Implikacje dla kodu
Decyzję egzekwują reguły kanonu MT-CODE-002 (`metator rules show MT-CODE-002`: plany, mapa, linie aktywności i dziennik edycji to dokumenty wersjonowane, pisane przez `writeDocument`/`stamp`), MT-CODE-003 (nowe wersje mają zamrożone schematy i przykład starszej wersji) i MT-TEST-003 (każdy nowy moduł ma mutanta).

- `packages/core/src/domain/plan-edit.ts`: widoki (`RunPlanView`, `PlanLintView`, `SystemPlanSummary`, `SystemPlanView`, `SystemMapView`), `documentDigest`, `documentFromBody`, `itemChanges`, dokument `PlanEdit`.
- `packages/core/src/application/plan-edit.ts` (`RunPlans`), `system-plan-edit.ts` (`SystemPlans`), `system-map-edit.ts` (`SystemMaps`), `run-artifacts.ts` (`RunArtifacts`); `LintPlan.check` i `LintSystemPlan.check` lintują plan, który nie jest jeszcze plikiem.
- `packages/core/src/domain/plan-board.ts`: artefakty z workflow runu, `planFile` (`plan.json` albo `plan.md`), sekcja `system`.
- Port `FileStats` z adapterem `BunFileStats` (`packages/plugin-bun`).
- Demon: `packages/cli/src/serve/routes/plans.ts`, `system.ts`, `artifacts.ts`; metoda `PUT` w `http.ts`.
