# ADR-0057: Folder repozytoriów (`metator.repos.yml`, `repos *`)

- Status: Accepted
- Data: 2026-10-27

## Kontekst
Użytkownik pyta, czy `metator` uruchamiać w folderze, w którym leżą wszystkie projekty, czy wewnątrz jednego z nich, i chce, żeby było to jasno udokumentowane ([design/10 §3.1](../design/10-repos-ask-tui.md)). Dotąd w folderze bez `.git` korzeniem był sam folder, więc komendy git zawodziły niejasno.

## Decyzja
- **Każde repozytorium ma własnego Metatora** (ADR-0056). Folder niczego nie współdzieli i niczego nie konfiguruje, tylko je zbiera.
- **Rozpoznanie folderu** (`findFolderRoot`):
  - folder ma plik `metator.repos.yml` (`RepoSet` v1);
  - albo sam nie jest repozytorium, a leżą pod nim repozytoria (`findChildRepos`, dwa poziomy w głąb, z pominięciem `node_modules`, `.metator` i katalogów ukrytych).
  
  Wewnątrz repozytorium zawsze wygrywa najbliższy `.git` (albo `metator.config.*`, teraz też `.yml`).
- **`RepoSet` v1:**
  - lista `{ path, name? }` ze ścieżkami względnymi, bez `..`;
  - nazwa domyślnie to ostatni człon ścieżki, a dwie takie same nazwy to błąd;
  - `repos init` proponuje plik z wykrytych repozytoriów, nazywając całą ścieżką tylko te, które by się zderzyły, i nigdy nie nadpisuje istniejącego.
- **Komendy w folderze:** `help`, `version`, `repos init|list|status`, `ui`, `ask`, `ask list`, `status` (lista `FOLDER_COMMANDS`). Każda inna kończy się `USAGE` w hooku `preAction` z nazwami repozytoriów i podpowiedzią `-C <repository>`. Nic nie zgaduje repozytorium za człowieka.
- **`metator ui` w folderze:** w G2 najpierw wybór repozytorium, potem jego sesje. Od G5 (ADR-0060) sesje wszystkich repozytoriów są na jednym ekranie, pogrupowane po repozytorium.
- CLI buduje kontener dla dowolnego repozytorium (`containerAt`), więc komendy folderu pracują na kontenerze każdego repozytorium osobno.

## Konsekwencje
### Pozytywne
- Jasna odpowiedź na „gdzie uruchamiać”: w repozytorium działa wszystko, w folderze działają widoki obejmujące wszystkie repozytoria, a reszta komend mówi, gdzie ją uruchomić.
- e2e na folderze z trzema prawdziwymi repozytoriami:
  - `repos list`, `init` (raz) i `status`;
  - `run init` w folderze daje podpowiedź, w repozytorium i z `-C` działa;
  - `ui` z wyborem repozytorium.
### Negatywne
- Folder bez `metator.repos.yml`, który zawiera repozytoria (np. katalog domowy), też jest traktowany jak folder repozytoriów. Komendy jednego repozytorium mówią wtedy wprost, co zrobić.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Jeden Metator dla całego folderu (wspólna konfiguracja i stan) | łamie niezależność repozytoriów; każde ma inne reguły, workflowy i hosty |
| Zgadywanie repozytorium w folderze (np. ostatnio używane) | komenda zmieniająca kod nie może trafić do niewłaściwego repozytorium |
| Nazwa `workspace` | `workspace list` już opisuje pakiety monorepo; `repos` mówi wprost, o co chodzi |

## Implikacje dla kodu
ADR-0057 egzekwują reguły kanonu MT-CODE-002, MT-TEST-001 (`metator rules show <id>`).
