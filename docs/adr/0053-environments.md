# ADR-0053: Środowisko aplikacji (`Environment`, `env discover|init|up|down|status|logs`)

- Status: Proposed
- Data: 2026-10-27

## Kontekst
Run w osobnym worktree (ADR-0050) potrzebuje działającej aplikacji: testów integracyjnych, sprawdzenia w przeglądarce, review zmiany na żywo. MetatorAI nie wiedział, jak aplikację uruchomić, a zimny start całego backendu w każdym worktree potrafi trwać 20 minut. Plan i decyzje: [design/09 §3.3 i §8](../design/09-workspaces-sessions.md): współdzielona infrastruktura (decyzja 3), w MVP tylko Docker (decyzja 4).

## Decyzja
- **`Environment` v1** (`metator/environment.yml`, w repo, przeglądany jak kod) opisuje usługi:
  - źródło: usługa Compose (`{ compose: { file, service } }`) albo skrypt (`{ script, cwd? }`);
  - zasięg: `shared` (jedna instancja dla wszystkich worktree), `worktree` (domyślny) albo `on-demand` (tylko na żądanie);
  - `needs`, nazwane porty z wartością poza worktree, `env` z `{port:<usługa>.<nazwa>}`, health (`tcp` z nazwą portu albo numerem, `http` ze ścieżką albo URL-em), `readyTimeoutMs`;
  - profile, czyli nazwane zestawy usług.

  `lintEnvironment` sprawdza: nieznane `needs` i usługi w profilach, port z health, usługa `shared` może potrzebować tylko usług `shared`, brak cykli (graphlib).
- **Porty w worktree:** usługi `worktree` dostają kolejne porty z bloku worktree w kolejności deklaracji. Usługi `shared` zachowują swoje porty, bo są jedne dla wszystkich.
  - Każdy proces dostaje porty wszystkich usług (`METATOR_PORT_<USŁUGA>_<NAZWA>`), własny pierwszy port jako `PORT` i zmienne worktree (`METATOR_WORKTREE`, `METATOR_PORT_BASE`).
  - Bez plików `.env`, tak jak w ADR-0050.
- **`env discover`** pokazuje dowód i pewność dla każdej usługi i niczego nie uruchamia. Źródła:
  - pliki Compose: usługa z obrazem infrastruktury (Postgres, MySQL, Redis, Kafka, RabbitMQ, Elasticsearch, Mongo…) bez `build` trafia do `shared`, reszta do `worktree`; `depends_on` staje się `needs`, porty `host:kontener` portami, a health to TCP na pierwszym porcie;
  - skrypty startowe (`dev`, `start`, `serve`) korzenia i pakietów workspace'u, uruchamiane menedżerem pakietów repo, z portem odczytanym z komendy. Korzeń, który tylko rozsyła do pakietów, nie jest usługą;
  - `Procfile`;
  - cel `Makefile`, tylko gdy nic innego nie znaleziono.

  **`env init`** zapisuje propozycję i nigdy nie nadpisuje.
- **`env up [usługi…] [--profile] [--worktree]`:**
  - kolejność wynika z `needs`, a usługa już działająca nie startuje drugi raz;
  - procesy idą w tle (`BackgroundProcess`) z logiem poza repo;
  - Compose: projekt `metator-shared` dla usług współdzielonych, `metator-<worktree>` albo `metator-main` dla reszty, więc worktree nie zatrzymują sobie kontenerów;
  - po każdej usłudze czeka na gotowość (port `HealthProbe` na `wait-on`, MIT; HTTP jako GET, bo wiele serwerów deweloperskich nie odpowiada na HEAD);
  - nieudana gotowość to błąd z ogonem logu, a usługa zostaje do diagnozy.
- **`env down`** zatrzymuje usługi danego miejsca od zależnych; współdzielone tylko z `--shared`. **`env status`** i **`env logs`** pokazują stan i logi (proces albo `docker compose logs`). `worktree rm` najpierw zatrzymuje usługi worktree.
- **Porty:** `ContainerRuntime` (adapter `DockerComposeRuntime` w nowym pakiecie `plugin-docker`; `METATOR_DOCKER_BIN` nadpisuje binarkę) i `HealthProbe`. `BackgroundProcess` dostaje środowisko procesu i `readLog`. Stan miejsc to **`EnvState` v1** (`.metator/env/<worktree|main|shared>.json`).

## Konsekwencje
### Pozytywne
- Współdzielona baza i broker startują raz; worktree uruchamia tylko swój kod na swoich portach. To pierwszy, największy krok do szybkiego startu (F8.7: pomiar, izolacja danych, częściowy start).
- Ta sama konfiguracja dla człowieka, agenta i CI; e2e na prawdziwych procesach i HTTP.
### Negatywne
- Compose czyta porty z otoczenia tylko tam, gdzie plik tego chce (`"${METATOR_PORT_API_P3000:-3000}:3000"`); stałe porty w pliku kolidują między worktree.
- Izolacja danych współdzielonej bazy (szablon bazy per worktree, prefiksy) to F8.7; do tego czasu worktree dzielą dane.
- `env up` nie śledzi stanu kontenerów poza swoim plikiem stanu; zatrzymany ręcznie kontener uchodzi za działający do `env down`.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| `docker compose config --format json` przy wykrywaniu | wymaga Dockera nawet do propozycji; odczyt YAML wystarcza do usług, portów i zależności |
| Własna pętla TCP/HTTP | ADR-0010: `wait-on` to sprawdzony pakiet |
| Osobny kontener bazy per worktree domyślnie | koszt zimnego startu, którego ta faza ma uniknąć (decyzja 3) |
