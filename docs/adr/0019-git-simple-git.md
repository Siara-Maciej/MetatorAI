# ADR-0019: Obsługa gita: simple-git

- Status: Proposed
- Data: 2026-10-25

## Kontekst
Port `Vcs` (`changedFiles(base)`, `listFiles()`) był zaimplementowany ręcznie: budowanie argumentów `git`, uruchamianie przez `ProcessRunner`, parsowanie wyjścia i mapowanie kodów wyjścia. To generyczna logika, którą ADR-0010 każe brać z gotowej biblioteki.

## Decyzja
**simple-git 4** (MIT, typy w pakiecie, aktywnie wydawany) w adapterze `GitVcs` (`packages/plugin-git`). Biblioteka uruchamia git, kolejkuje polecenia, parsuje `status -z` (pliki nieśledzone) i zamienia błędy na wyjątki; adapter mapuje je na `MetatorError` (`NOT_FOUND` poza repo, `USAGE` dla nieznanej bazy, `COMMAND_FAILED` dla pozostałych).
- Zmiany względem bazy: `merge-base` + `diffSummary(["--no-renames", ref])` + nieśledzone z `status()`; oba wyniki parsuje biblioteka. Własne wywołania (`raw`) zostają tylko tam, gdzie simple-git nie ma API: `merge-base` i `ls-files`. `--no-renames`: zmiana nazwy liczy się pod starą i nową ścieżką, bo importerzy starej ścieżki są dotknięci.
- Repo bez commitów (`HEAD` nienarodzony): wszystkie pliki z `status()`.
- simple-git traktuje kod wyjścia ≠ 0 bez stderr jako sukces, więc nie używamy `--quiet` i sprawdzamy puste wyjście (`rev-parse`, `merge-base` bez wspólnego przodka).

## Konsekwencje
### Pozytywne
- Mniej własnego kodu; semantyka gita (w tym `.gitignore`, globalne excludes) pozostaje semantyką prawdziwego gita.
### Negatywne
- Wymaga binarki `git` w PATH (jak wcześniej).
- `GitVcs` nie przechodzi już przez port `ProcessRunner`; testy adaptera działają na prawdziwych repozytoriach.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| isomorphic-git | czysty JS bez binarki, ale wolny na dużych repo i z niepełną obsługą ignorów (brak globalnych excludes, `info/exclude` częściowo) |
| nodegit / es-git (libgit2) | natywne bindingi, cięższa instalacja, problemy z Bun |
| Ręczne wywołania git przez ProcessRunner | duplikuje bibliotekę (ADR-0010) |
