# ADR-0033: Evale review: złoty zbiór, punktacja i bramka regresji

- Status: Accepted
- Data: 2026-10-26

## Kontekst
Bez pomiaru review agentowe nie jest „enterprise” ([research §8.5](../design/00-research-v1.md)). Kryterium wyjścia F3 mierzy precision potwierdzonych blockerów, recall zasianych bugów i wariancję decyzji na złotym zbiorze. Prompty to kod: zmiana agenta nie może pogorszyć wyników.

## Decyzja
- **`EvalCase`** (YAML, ADR-0016) w `docs/metator/evals/golden/<id>.yml`:
  - `type: bug|seeded|clean`, refy `base`/`head`;
  - `expected`: plik, linia z `tolerance` (domyślnie 3), opcjonalna soczewka i severity;
  - przypadek `clean` nie może oczekiwać znalezisk.
- **Punktacja** (`scoreCase`, `totals`):
  - zgłoszenie pasuje do oczekiwanego, gdy plik się zgadza, linia mieści się w tolerancji, a soczewka (także z `alsoFrom`) się zgadza; każde oczekiwane dopasowuje się raz, a obalone zgłoszenia się nie liczą;
  - liczymy precision, recall, `blockingPrecision` (odsetek prawdziwych wśród potwierdzonych blockerów), `falseBlocks` (zablokowane czyste zmiany) i `decisionVariance` (odsetek przypadków ze zmienną decyzją między powtórzeniami).
- **`metator eval run --command <szablon> [--repeat 3]`:**
  - uruchamia przegląd hosta headless (np. `copilot -p … --agent mt-pr-review` albo `claude -p …` w skrypcie) per przypadek i powtórzenie;
  - placeholdery `{case} {base} {head} {out} {run}` oraz zmienne `METATOR_EVAL_*`;
  - szablon jest dzielony jak przez powłokę (`shell-quote`), ale nigdy nie trafia do powłoki: operatory to błąd użycia;
  - potem następuje punktacja.
- **`metator eval score <dir>`** czyta `<dir>/<case>/<run>/findings/merged.json` i `verdict.json`, a wynik zapisuje jako wersjonowany `EvalReport`. **`metator eval compare <before> <after> [--tolerance 0.02]`** to bramka: spadek ponad tolerancję albo więcej fałszywych blokad oznacza czerwony wynik.

## Konsekwencje
### Pozytywne
- Każda zmiana agentów review ma liczbowy wynik i bramkę w CI (W12, `mt-eval.yml` w F5).
- Rdzeń nie zależy od hosta: host jest tylko komendą w szablonie.
### Negatywne
- Złoty zbiór (≥ 50 PR-ów z prawdziwymi i zasianymi bugami oraz czystych) trzeba zbudować w repo pilota; MetatorAI nie ma jeszcze własnego.
- Dopasowanie po linii z tolerancją nie rozpozna trafnego znaleziska zgłoszonego w innym miejscu tego samego błędu.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Ocena przez model (LLM-as-judge) | niedeterministyczna; bramka regresji musi być powtarzalna |
| Uruchamianie szablonu przez `sh -c` | wstrzyknięcie przez nazwy przypadków i refy; skrypt opakowujący wystarcza |

## Implikacje dla kodu
ADR-0033 egzekwują reguły kanonu MT-CODE-002, MT-TEST-003 (`metator rules show <id>`).
