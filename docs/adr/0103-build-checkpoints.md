# ADR-0103: Punkty kontrolne w buildzie: krok jest zrobiony, gdy jego testy przeszły

- Status: Proposed
- Data: 2026-11-15
- Numer: na gałęzi `claude/determined-galileo-4hfn27` ten ADR miał numer 0089, zajęty już w głównej linii; przenumerowany decyzją właściciela z 2026-11-22.

## Kontekst
Etap build (mt-test-author, potem mt-implementer) miał jedną twardą bramkę: etap `gates` po całym buildzie (`metator gate full`). To, czy pojedynczy krok planu działa, było zdaniem w prompcie implementera („`metator test affected` until green") i notatką w `build-log.md`, którego nic nie czyta. Błąd wprowadzony w kroku S2 wychodził dopiero po wszystkich krokach, w pełnej bramce, a przy kilkugodzinnych sesjach bez nadzoru oznacza to przegląd całości zamiast krótkiego punktu kontrolnego. Zasada: weryfikacja to punkty kontrolne pass/fail po drodze, egzekwowane przez harness, nie prośba w prompcie.

## Decyzja
- **`metator plan done <plan.json> <step>`** uruchamia testy, do których sięga plik kroku i jego `testsFirst` (ten sam `test affected`, ten sam skrypt `test`), i zapisuje wynik, zielony lub czerwony, z komendą i końcówką wyjścia w `build-progress.json` obok planu. Czerwony krok kończy się `CHECK_FAILED` z wyjściem testów. Krok, którego zależności (`dependsOn`) nie przeszły, jest odrzucany, zanim cokolwiek się uruchomi.
- **Nowy dokument `BuildProgress` v1** (wersjonowany, schemat zamrożony): dla każdego kroku `passed`, `at`, `tests`, `command`, `exitCode`, `output`.
- **`metator plan progress <plan.json> [--check]`** pokazuje stan kroków (`passed`, `failed`, `pending`); z `--check` nie przechodzi, dopóki każdy krok nie przeszedł.
- **Bramka etapu build** w `mt-feature` (rewizja 5), `mt-bugfix` (5) i `mt-review-response` (3): `metator plan progress {runDir}/plan.json --check`, przy porażce powrót do `build` w ramach pętli `build`. Refaktor (`mt-refactor`) ma własne bramki i zostaje bez zmian.
- **mt-implementer** dostaje grupę `metator:plan` i procedurę: `plan done` po każdym kroku.

## Konsekwencje
### Pozytywne
- Błąd zatrzymuje krok, w którym powstał; osoba widzi w artefakcie, co uruchomiono i co padło.
- Bramka jest deterministyczna: agent nie może ogłosić końca buildu bez zielonych kroków.

### Negatywne
- Krok, który przeszedł, a potem został zepsuty przez późniejszy, nie jest oznaczany jako nieaktualny; łapie to dopiero etap `gates` (`gate full`). Kandydat na rozszerzenie: zapamiętany skrót treści pliku kroku.
- Kroki tylko z testami (np. S1 tworzący plik testów) przechodzą dopiero, gdy istnieje kod, który importują; implementer sprawdza je razem z krokiem kodu.
- Dłuższy build: testy kroków uruchamiają się osobno (zwykle mały podzbiór).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Hook `SubagentStop` blokujący implementera | hook nie wie, które kroki należały do danego subagenta |
| Tylko zapis w `build-log.md` | Markdown nie jest parsowany (ADR-0016); bramka potrzebuje dokumentu |
| Pełna bramka po każdym kroku | koszt czasu bez dodatkowej informacji o kroku |

## Implikacje dla kodu
- Reguły kanonu, które to wiążą: `BuildProgress` jest wersjonowanym dokumentem z zamrożonym schematem (MT-CODE-002, MT-CODE-003); use case'y biorą porty przez konstruktor i zwracają `Result` (MT-ARCH-006, MT-CODE-001); `plan done` i `plan progress` mają e2e na prawdziwym procesie z prawdziwym `bun test` (MT-TEST-001) i zabite mutanty (MT-TEST-003).
- `packages/core/src/domain/plan.ts` (`BuildProgressDocument`), `packages/core/src/application/plans.ts` (`CheckPlanStep`, `PlanProgress`), `packages/cli/src/commands/plan.ts`.
- Workflowy `mt-feature`, `mt-bugfix`, `mt-review-response`; agent `mt-implementer`; dokumentacja `site/use/feature.md`.
