# ADR-0044: `run handoff|close`, `lessons add`, `findings check-quote`, `debug-tags check`

- Status: Proposed
- Data: 2026-10-26

## Kontekst
Katalog komend (04-commands §4) ma kilka małych narzędzi, bez których workflowy W1–W8 kończą się ręcznie:
- przekazanie runu koledze i zamknięcie go z telemetrią (P1);
- zapis lekcji z cytatem po retrospektywie (P1);
- sprawdzenie jednego cytatu przez weryfikatora (P0);
- dowód, że po diagnozie nie zostały w kodzie logi `[DEBUG-…]` (P2).

## Decyzja
- **`run handoff`** pisze `<run>/handoff.md` (`RunHandoff` v1). Treść pochodzi z tablicy runu, nie z rozmowy: zadanie, etap, czego oczekuje, zgody, pętle, artefakty, ostatnie wpisy logu i instrukcja wznowienia.
- **`run close`** pisze `<run>/summary.json` (`RunSummary` v1) z końcową telemetrią:
  - status, czas trwania;
  - liczba zdarzeń PASS/FAIL/APPROVE/ABORT;
  - zgody, artefakty.

  Aktywnego runu nie zamyka po cichu. `--aborted --reason` najpierw wysyła ABORT przez maszynę stanów, więc ślad w logu jest ten sam co przy `run advance abort`. `RunRecord` się nie zmienia: zamknięcie oznacza istnienie `summary.json`.
- **`lessons add`** zapisuje lekcję (`Lesson` v1, Markdown z front matter) w `docs/metator/lessons/` tylko wtedy, gdy cytat jest prawdziwy. Do sprawdzenia służy ten sam `locateQuote` co w `memory validate`. Przesunięty cytat jest zapisywany z prawdziwą linią, istniejąca lekcja nie jest nadpisywana. Mapa pamięci dostaje pozycję `t4.lessons`.
- **`findings check-quote <file> --line --quote`** sprawdza jeden cytat tym samym dopasowaniem: wynik ok, moved (z prawdziwą linią) albo stale. Moved i stale kończą się `CHECK_FAILED`.
- **`debug-tags check [--base]`** szuka znaczników `[DEBUG-` z co najmniej czterema cyframi hex i `]`. Bez `--base` sprawdza wszystkie pliki repo, z `--base` tylko zmienione. Pomija `sourceIgnores`. Wymóg cyfr hex sprawia, że opisy w dokumentacji (`[DEBUG-xxxx]`) nie są znacznikami. Skill `mt-diagnose` wymaga tej komendy przed bramkami.

## Konsekwencje
### Pozytywne
- Handoff i wznowienie nie zależą od pamięci rozmowy; telemetria runu jest w pliku wersjonowanym.
- Lekcja bez dowodu nie powstaje; weryfikator sprawdza cytat jedną komendą.
### Negatywne
- `summary.json` nie jest agregowany między runami; dashboard (F5) przeczyta pliki.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Status `closed` w `RunRecord` (v3) | migracja dla jednej flagi, którą wyraża istnienie `summary.json` |
| Lekcje bez cytatu, walidowane później | lekcja bez dowodu trafiałaby do kontekstu agentów do nocnego przebiegu |
