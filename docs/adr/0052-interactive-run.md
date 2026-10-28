# ADR-0052: Interaktywny `metator run` i `run continue`

- Status: Proposed
- Data: 2026-10-27

## Kontekst
Po `run init` człowiek wpisywał kolejne komendy. Po F8.3 CLI prowadzi run samo (`run drive`), a pytania są dokumentami `Question`. Brakowało ciągłego widoku w terminalu, odpowiadania na miejscu i powrotu do zatrzymanego runu. Plan: [design/09 §3.6](../design/09-workspaces-sessions.md).

## Decyzja
- **`metator run` w terminalu:**
  - kreator pyta o workflow, zadanie, autonomię, hosta (z zarejestrowanych) i o worktree (domyślnie tak);
  - potem `run init`, drive w tle (ten sam mechanizm co `run drive --detach`) i **widok na żywo**.
- **Widok na żywo** (`follow`) czyta `activity.jsonl` i wypisuje linię na wpis (`formatActivity`: etap, agent, narzędzie, wynik przejścia).
  - Każde otwarte pytanie zadaje na miejscu (wybór z opcji; `Other`, `Reject` i `Deny` dopytują o słowa) i zapisuje odpowiedź przez `RunJournal.answer`, jak `run answer`.
  - Kończy się, gdy run się skończy albo jego drive zniknie.
  - Ctrl+C odłącza tylko widok (`detached: true`), a run idzie dalej w tle.
- **`run continue [run] [--host]`:**
  - bez argumentu w terminalu: lista aktywnych runów ze stanem „waits for you (n)”, „driving” albo „stopped”;
  - bez terminala: najnowszy aktywny run.

  Gdy run nie ma żywego drive'a, startuje go z hostem, którego run używał (`RunRecord.host`). W terminalu przechodzi w widok na żywo, bez niego zwraca kopertę z driverem.
- **Odpowiedź w zawieszeniu:** odpowiedź udzielona po ostatniej zmianie runu (`updatedAt`) jeszcze nie została wykonana. Wznowiony drive jej używa, zamiast pytać drugi raz. Tak widok może odpowiedzieć, zanim nowy proces dojdzie do bramki.
- **Port wejścia/wyjścia człowieka `Terminal`** (CLI) zastępuje `SetupPrompter`: `setup`, `newRun`, `pickRun`, `answer`, `show`. Implementacja na `@clack/prompts` pisze na stderr, więc stdout dalej niesie jedną kopertę JSON. `null` zawsze znaczy anulowanie. Komendy wołane przez `invoke` nie dostają terminala.
- Kto odpowiada: `METATOR_USER`, potem login.
- **Bez terminala** `metator run` zwraca `USAGE` z podpowiedzią (`run init` + `run drive`).

## Konsekwencje
### Pozytywne
- Jedna komenda od zadania do końca runu; pytania i bramki w miejscu; wyjście i powrót bez utraty stanu.
- e2e w prawdziwym pseudo-terminalu: kreator, bramka, pytanie agenta, `run continue`, Ctrl+C.
### Negatywne
- Widok odpytuje pliki co 300 ms; przy bardzo długich runach czyta cały `activity.jsonl` za każdym razem (do optymalizacji, gdy będzie potrzebna).
- Pełnoekranowy widok wielu sesji to F8.6 (`metator ui`).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Drive w tym samym procesie co widok | Ctrl+C zabijałby run; proces w tle przeżywa zamknięcie terminala (decyzja 2) |
| Nowe pole „wykonana” w `Question` v1 | wydana wersja się nie zmienia; czas odpowiedzi względem `updatedAt` wystarcza |
