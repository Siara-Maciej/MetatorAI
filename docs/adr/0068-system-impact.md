# ADR-0068: `system impact`: mapa przypięta w repozytorium platformy, źródła innych repozytoriów i zasięg zmiany

- Status: Accepted
- Data: 2026-10-29

## Kontekst
Mapa systemu (ADR-0047) opisuje aplikacje w wielu repozytoriach, ale do tej pory była czytana tylko z repozytorium, w którym działa komenda, a specyfikacji z innych repozytoriów `system lint` nie sprawdzał. Projekt F7 ([design/08 §6 S3](../design/08-system-landscape.md)) zakłada jedną mapę w repozytorium platformy, przypiętą w repozytoriach aplikacji, i odpowiedź na pytanie „dokąd sięga ta zmiana”: zmienione pliki → kontrakty → konsumenci → właściciele.

## Decyzja
- **`MetatorConfig` v4, sekcja `system`:**
  - `map`: `{ path }` (plik tego repozytorium) albo `{ repo, ref?, path }` (repozytorium platformy, URL albo ścieżka względna);
  - `roots`: lokalne checkouty aplikacji (`billing: ../billing`);
  - `self`: które aplikacje to repozytorium (gdy samo wykrywanie nie wystarcza).

  v3 migruje bez zmian.
- **Porty:**
  - `RepositoryCloner`: `resolve(repo, ref)` daje commit (`ls-remote`, z commitem tagu adnotowanego `^{}`, sha zostaje sha), a `checkout(repo, sha, dir)` klonuje raz i używa ponownie;
  - `CheckoutReader`: odczyt pliku z checkoutu, bez wychodzenia poza jego katalog, i sprawdzenie katalogu.

  Adaptery to `GitRepositoryCloner` (simple-git, ADR-0019) i `BunCheckoutReader`.
- **Mapa przypięta:**
  - `PinnedSystemLocation` czyta mapę z klonu dokładnie tego commita, w `.metator/system/<repo>@<sha12>`;
  - względne `repo` w mapie (`../billing`) liczą się od prawdziwego miejsca repozytorium platformy, nie od klonu.
- **Źródła aplikacji** (`SystemSources.locate`), w kolejności:
  - `system.roots.<id>`, gdy katalog istnieje;
  - aplikacja `path`: checkout mapy (`here` albo `map`);
  - `repo` jako ścieżka bez `ref`: ten katalog;
  - w pozostałych przypadkach klon, tylko z `--fetch`.

  Bez `--fetch` nic nie idzie do sieci.
- **`system impact [--base] [--files] [--contracts]`:**
  - aplikacje tego repozytorium (`self`) to `system.self`, albo te, których `repo` to remote albo ścieżka tego repozytorium, albo (gdy mapa jest tutaj) aplikacje `path`;
  - plik należy do najgłębszej aplikacji;
  - zmiana kontraktu to `spec` (zmieniła się specyfikacja), `implementation` (inne pliki dostawcy) albo `named` (wskazany wprost). `spec` wygrywa;
  - każda aplikacja dostaje powody i właścicieli, a pliki poza aplikacjami trafiają do `unmapped`;
  - wynik jest deterministyczny: kontrakty są uporządkowane po id.
- **`system sources [--fetch]`** pokazuje, gdzie jest kod każdej aplikacji, z ostrzeżeniem dla brakujących.
- **`system lint --fetch`** sprawdza specyfikacje w innych repozytoriach. Bez checkoutu kontrakt trafia do `unchecked`, a nie jest błędem.

## Konsekwencje
### Pozytywne
- Jedna mapa dla wielu repozytoriów, przypięta do commita, więc CI i przegląd widzą tę samą wersję.
- Agent zmieniający kontrakt dostaje listę konsumentów i właścicieli, także z repozytoriów, których nie ma na dysku.
- e2e:
  - trzy prawdziwe repozytoria (platforma, billing, web) z mapą przypiętą do `main`;
  - zmiana specyfikacji i kodu, kontrakt wskazany z repozytorium konsumenta;
  - `sources` i `lint --fetch` w platformie.
### Negatywne
- Klon zajmuje miejsce w `.metator/system/`. Cache jest per commit, więc stare klony trzeba sprzątać ręcznie.
- Zasięg liczony jest na poziomie kontraktu. Czy zmiana `implementation` łamie zgodność, rozstrzyga dopiero `contract diff` (F7.4).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Git submodules albo kopiowanie mapy do każdego repozytorium | kopie się rozjeżdżają; przypięcie `ref` daje tę samą wersję bez duplikatu |
| Klonowanie zawsze, bez `--fetch` | komendy bez sieci muszą działać lokalnie i szybko; sieć tylko na żądanie |
| `git archive --remote` zamiast klonu | GitHub i wiele serwerów go nie obsługuje |
| Sparse checkout tylko mapy | oszczędza miejsce, ale klon i tak jest potrzebny do specyfikacji aplikacji `path`; prostota wygrywa |

## Implikacje dla kodu
ADR-0068 egzekwują reguły kanonu MT-CODE-003, MT-ARCH-008 (`metator rules show <id>`).
