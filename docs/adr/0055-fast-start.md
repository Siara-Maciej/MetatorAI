# ADR-0055: Szybki start środowiska (`env analyze`, izolacja danych, pula, częściowy start)

- Status: Accepted
- Data: 2026-10-27

## Kontekst
Po F8.5 każdy worktree startuje swoje usługi od zera. Przy typowym backendzie zimny start to minuty: instalacja zależności, build, migracje i seed bazy. Współdzielona infrastruktura (decyzja 3) usuwa część kosztu, ale dane runów się mieszają, a seed i migracje i tak trzeba gdzieś zrobić. Plan: [design/09 §3.4](../design/09-workspaces-sessions.md), kryterium F8.7: na repo z wolnym seedem drugi worktree startuje ≥ 10× szybciej niż zimny start, zmierzone i zapisane w profilu.

## Decyzja
- **`Environment` v2** (migracja tożsamościowa z v1; każdy plik v1 jest poprawnym v2). Nowe pola usługi:
  - `paths`: katalogi z kodem usługi, dla `env up --affected`;
  - `prepare`: kroki przed startem (install, build), w kolejności;
  - `init`: kroki po gotowości (migracje, seed); usługi `shared` wykonują je raz, przy swoim starcie;
  - `isolate`: `{ postgres: { template, database, user?, port? } }` albo `{ prefix: true }`, tylko dla usług `shared`;
  - `warm.reuse`: katalogi kopiowane z głównego checkoutu przed `prepare`, gdy pliki `warm.key` (domyślnie lockfile'y) są w obu checkoutach takie same.
- **Pomiar faz.** `env up` zwraca dla każdej uruchomionej usługi fazy z czasami: `isolate`, `reuse`, kroki `prepare`, `start` (od uruchomienia do gotowości), `template`, kroki `init`.
- **Izolacja danych w Postgres (port `DataIsolator`).**
  - Wspólny Postgres po starcie tworzy bazę-szablon. Jego `init` dostaje `METATOR_DATABASE=<template>` i wypełnia ją raz.
  - Każde miejsce dostaje klon przez `CREATE DATABASE … TEMPLATE` (sekundy): checkout bazę `database`, worktree bazę `wt_<id>`. Klon tworzy się przed startem usługi worktree, która potrzebuje Postgresa.
  - Placeholdery `{db:<usługa>}` i `{prefix:<usługa>}` w `env`.
  - `worktree rm` usuwa bazę worktree dopiero po udanym usunięciu worktree (`DROP DATABASE … WITH (FORCE)`).
  - Adapter `BunSqlDataIsolator` używa klienta Postgres wbudowanego w Bun (bez nowej zależności). Nazwy baz są ograniczone do `[a-z_][a-z0-9_]{0,62}`, więc cytowanie jest bezpieczne. Hasło pochodzi z `PGPASSWORD`. Przejściowy błąd „database system is starting up” (57P03) jest ponawiany.
- **Ponowne użycie buildu (port `TreeCopier`).** Adapter `NodeTreeCopier` to `node:fs cp` z `COPYFILE_FICLONE`: reflink tam, gdzie system plików go ma, a w przeciwnym razie zwykła kopia. Dowiązania symboliczne zostają dowiązaniami. Nigdy nie nadpisuje istniejącego katalogu.
- **Częściowy start.** `env up --affected [--base]` zbiera zmienione pliki: w worktree od miejsca, w którym odgałęził się od HEAD checkoutu, łącznie z nieśledzonymi. Dodaje pliki zależne z grafu importów (`computeAffected`). Startuje usługi, których `paths` obejmują te pliki, oraz to, czego potrzebują. Usługa worktree bez `paths` liczy się zawsze. Między aplikacjami (`system impact`) dojdzie w F7.3.
- **Pula ciepłych worktree.** `env pool --size n` utrzymuje n wolnych worktree `pool-<k>` na HEAD z uruchomionymi usługami. `run init --worktree` bierze wolny (`ProvideWorktree`): przełącza go na gałąź runu (`WorktreeManager.switchBranch`, baza rozwiązywana w checkoucie, gałąź puli usuwana) i zapisuje run we wpisie rejestru. `env pool --drain` usuwa wolne. Dokument `WorktreeRegistry` v1 się nie zmienia: pula to wpisy `pool-*` bez runu.
- **`env analyze [--cold]` i `EnvProfile` v1** (`.metator/env-profile.json`):
  - Uruchamia całe środowisko w dwóch tymczasowych worktree (`analyze-cold`, potem `analyze-warm`) i mierzy fazy.
  - Liczy ścieżkę krytyczną w grafie `needs` i przyspieszenie (zimny / ciepły).
  - Rekomendacje opierają się wyłącznie na pomiarach, każda ma dowód i szacowany zysk: `reuse-build`, `template-database`, `warm-pool`, `partial-start`, `cold-measure`. Rekomendacje nigdy nie zmieniają `environment.yml`; człowiek przenosi je sam.
  - Po pomiarze usuwa oba worktree i ich bazy, zatrzymuje usługi współdzielone, które sam uruchomił, a te działające wcześniej zostawia. Z `--cold` najpierw je restartuje, żeby zmierzyć także ich start.
- **Poprawki znalezione przy okazji:**
  - `BunBackgroundProcess.stop` sygnalizuje całą grupę procesów (`sh -c` zostawiał usługę jako sierotę na zajętym porcie);
  - `isAlive` nie liczy zombie (w kontenerze bez init sieroty nie są sprzątane);
  - logi procesów leżą w osobnym katalogu na repozytorium (`$TMPDIR/metator-<hash>`), a nie we wspólnym `$TMPDIR`.

## Konsekwencje
### Pozytywne
- Kryterium F8.7 zmierzone w e2e: seed 8 s, drugi worktree startuje ≥ 10× szybciej, wynik zapisany w profilu.
- Każdy run ma własne dane od pierwszej sekundy. e2e na prawdziwym Postgresie: klon ma dane z seedu, zapis w jednym klonie nie trafia do drugiego ani do szablonu, a `worktree rm` usuwa bazę.
- Run z puli startuje bez seedu i bez startu usług.
### Negatywne
- Izolacja danych obejmuje na razie Postgres i prefiksy. MySQL, snapshoty wolumenów i obrazy budowane na hash lockfile'a są do zrobienia później.
- Pula zużywa zasoby, gdy stoi bezczynnie. Limitem jest `--size`; TTL jeszcze nie ma.
- `env analyze` trwa tyle, co dwa starty środowiska.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Osobny kontener bazy per worktree | seed i migracje per worktree to właśnie koszt, który usuwamy; szablon klonuje się w sekundy |
| Biblioteka `pg` albo `postgres` (npm) | Bun ma klienta Postgres wbudowanego, bez nowej zależności |
| `cp --reflink` przez powłokę | `node:fs cp` z FICLONE robi to samo przenośnie i zwraca błąd jako wartość |
| Nowe pole „pool” w `WorktreeRegistry` | wydana wersja się nie zmienia; wpis `pool-*` bez runu wystarcza |
| Rekomendacje zapisywane od razu w `environment.yml` | plik jest przeglądany jak kod; zmiana należy do człowieka |

## Implikacje dla kodu
ADR-0055 egzekwują reguły kanonu MT-CODE-002, MT-TEST-002 (`metator rules show <id>`).
