# ADR-0036: `graph diff` i `test affected`

- Status: Accepted
- Data: 2026-10-26

## Kontekst
Bramka `gate all` (04-commands §E) potrzebuje dwóch faktów o zmianie: jak zmienia graf importów (`graph diff`) i które testy ją dosięgają (`test affected`). `graph affected` już wyznacza dotknięte pliki, ale nie uruchamia testów i nie porównuje grafu z bazą.

## Decyzja
- **Port `RevisionReader`** (`readAt(base, path)`): treść pliku w merge base `base` i HEAD; `undefined`, gdy pliku tam nie było. Port jest wydzielony z `Vcs` (oś zmiany: historię czyta niewiele use case'ów; MT-ARCH-008). Implementuje go `GitVcs` (`git cat-file -e`, potem `git show`), a merge base liczy ta sama metoda co w `changedFiles`.
- **`graph diff --base <ref>`** (`DiffImportGraph`): graf bazy to obecny graf, w którym krawędzie każdego zmienionego pliku zastąpiono krawędziami jego wersji z merge base, sparsowanej i rozwiązanej tym samym analizatorem. Wynik zawiera:
  - `added` i `removed`, bez krawędzi zewnętrznych;
  - `newPackageDependencies`: pakiet zaczyna zależeć od pakietu, od którego wcześniej nie zależał, z jedną krawędzią jako dowodem;
  - `newCycles`: cykle, których nie było w bazie i które domyka dodana krawędź.
- **`test affected`** (`RunAffectedTests`): testy z `ComputeAffected` (graf odwrotny plus `project.testGlobs`) uruchamiane skryptem repo (`--script`, domyślnie `test`) przez menedżer pakietów, z plikami doklejonymi na końcu. Bez dotkniętych testów nic nie jest uruchamiane. Czerwony wynik daje `CHECK_FAILED` z ogonem wyjścia.

## Konsekwencje
### Pozytywne
- Bramka widzi nowe sprzężenia pakietów i cykle przed review; refactor z „zerowym” wpływem da się wykazać.
- `test affected` używa runnera i flag repo, więc działa dla bun, vitest i jest bez adapterów.
### Negatywne
- Krawędzie bazy dla zmienionych plików rozwiązywane są względem obecnego drzewa: import pliku usuniętego na gałęzi nie rozwiąże się w bazie (krawędź do niego nie pojawi się w `removed`). Ten przypadek łapie typecheck.
- Skrypt testów musi przyjmować pliki jako argumenty (większość runnerów przyjmuje).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| `git worktree` bazy i drugi pełny indeks | worktree nie ma `node_modules`, więc pakiety workspace nie rozwiązują się bez kopiowania instalacji |
| Snapshot grafu zapisywany na gałęzi bazowej | wymaga CI na bazie; lokalnie go nie ma |
| Własny runner testów | MetatorAI nie powinien znać runnera; skrypt repo już go zna |

## Implikacje dla kodu
ADR-0036 egzekwują reguły kanonu MT-TEST-001, MT-ARCH-008 (`metator rules show <id>`).
