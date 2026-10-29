# ADR-0071: Runy powiązane: run systemowy W13 i runy-dzieci w repozytoriach aplikacji

- Status: Accepted
- Data: 2026-10-29

## Kontekst
Plan systemowy (ADR-0070) dzieli zmianę na kroki per aplikacja. Design/08 §3.2 przyjmuje, że **agent nie edytuje wielu repozytoriów w jednej sesji**: analiza i plan obejmują system, a wykonanie idzie przez runy powiązane, czyli run systemowy (rodzic) i runy W1 w repozytoriach aplikacji (dzieci). `RunRecord` v3 (ADR-0050) ma już `parent` i `children`, ale nie wie, który krok którego planu run wykonuje.

## Decyzja
- **`RunRecord` v4** dodaje opcjonalne `system: { plan, step, app }`. Rekord v3 czyta się bez zmian (run spoza planu). `run init --parent <run>` zapisuje rodzica, a log runu dostaje linie `parent` i `system`.
- **`system plan run [<id>] [--run <run systemowy>] [--base] [--workflow]`:**
  - plan musi być zatwierdzony i nienaruszony (digest);
  - startują kroki gotowe (`readySteps`: `pending`, wszystkie zależności `done`);
  - kod aplikacji jest wskazywany przez `SystemSources.locate`. Krok startuje tylko w checkoucie, w którym ktoś pracuje (to repozytorium albo `system.roots`), bo klony w `.metator/system/` są tylko do odczytu;
  - run-dziecko (domyślnie W1 `mt-feature`) powstaje w tamtym repozytorium przez jego własny kontener, z zadaniem z opisu kroku (plan, krok, katalog, kontrakty, zależności, flaga, rollback, zadanie);
  - rodzic dostaje dziecko w `children` i linię w logu, a krok dostaje `run` i status `running`.
- **`system status [<id>] [--run] [--check]`:**
  - runy-dzieci są odczytywane z ich repozytoriów: `done` daje krok `done`, a `escalated`/`aborted` krok `blocked`;
  - wynik trafia do planu, a plan jest `done`, gdy wszystkie kroki są `done`;
  - `--check` kończy się `CHECK_FAILED`, dopóki plan nie jest gotowy.
- **`--run` przyjmuje id runu albo jego katalog** (bramka W13 podaje `{runDir}`). Plan to `planId(zadanie runu)`, więc run systemowy i jego plan mają to samo zadanie.
- **W13 `mt-system-change`:**
  1. analyze (`mt-system-scout`);
  2. plan (`mt-system-planner`);
  3. plan-gate (`system plan lint --run {runDir}`);
  4. plan-approval (HITL, nigdy pomijany);
  5. children (`system plan run --run {runDir}`);
  6. status (bramka `system status --check`, `onFail` wraca do children w pętli `waves`);
  7. delivery (HITL).

## Konsekwencje
### Pozytywne
- Każda zmiana w repozytorium przechodzi jego własne bramki, reguły i zgody. Run systemowy tylko planuje, uruchamia i odczytuje.
- Powiązanie działa w obie strony (rodzic → dzieci, dziecko → rodzic i krok), więc `run status` w repozytorium aplikacji mówi, po co ten run istnieje.
- e2e na trzech prawdziwych repozytoriach:
  - run W13 w platformie startuje run-dziecko w billing;
  - web czeka, aż billing będzie `done`;
  - `system status --check` kończy plan;
  - krok bez checkoutu nie startuje.
### Negatywne
- Status kroków jest odczytywany na żądanie (`system status`), bez powiadomień.
- Run-dziecko w repozytorium bez workflow `mt-feature` nie powstanie: workflow musi być zainstalowany w każdym repozytorium aplikacji (`metator setup`).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Jeden run edytujący wiele repozytoriów | omija bramki i zgody per repozytorium, a hosty pracują w jednym repozytorium (design/08 §3.2) |
| Runy-dzieci w klonach z cache | zmiana w klonie nie trafia do nikogo; klony są tylko do odczytu |
| Krok systemowy jako nowy `children` z obiektami w v3 | wersja wydana się nie zmienia (MT-CODE-003); dziecko zna swój krok, rodzic zna id dzieci |

## Implikacje dla kodu
ADR-0071 egzekwują reguły kanonu MT-CODE-003, MT-TEST-001 (`metator rules show <id>`).
