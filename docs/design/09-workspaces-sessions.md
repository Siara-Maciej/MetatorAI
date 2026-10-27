# Worktree, środowiska aplikacji i sesje w CLI (analiza i plan)

Status: **zaakceptowany kierunek, decyzje w sekcji 8** (2026-10-27). Realizacja od F8.1.

## 1. Problem

Zebrane z rozmowy z użytkownikiem, w pięciu obszarach:

1. **Ciężki start aplikacji w nowym worktree.**
   - Każdy run powinien pracować w osobnym worktree, żeby runy nie przeszkadzały sobie nawzajem ani człowiekowi.
   - Niektóre aplikacje (backend z bazą, brokerem i kilkoma serwisami) potrzebują przy zimnym starcie około 20 minut. Główne koszty to obrazy, zależności, build, migracje i dane testowe.
   - MetatorAI ma **sam rozpoznać**, jak uruchomić aplikację, a gdy nie rozpozna, zapytać użytkownika i zapisać odpowiedź.
   - Ma też **przeanalizować** start: co trwa długo, co da się współdzielić, a co wystarczy uruchomić częściowo.
2. **Instalacja w repo jedną komendą** zamiast ręcznego `cp -r …/metator`, `cp -r …/workflows` i `metator generate`. Przy instalacji wybieramy dostawcę agentów (Claude Code, GitHub Copilot, oba).
3. **Interaktywny, ciągły run w CLI.** Po `metator run` widać, co się dzieje, a pytania i bramki pojawiają się na miejscu. Dziś po `run init` trzeba ręcznie wpisywać `run advance` i `run approve`.
4. **`run continue`:** wybór zatrzymanego runu z listy i dalsza praca.
5. **Sesje w UI terminala:**
   - lista sesji, przełączanie między nimi, nowy run;
   - skrzynka pytań do mnie;
   - aplikacje sesji: uruchomienie, podgląd, otwarcie kodu w ulubionym edytorze albo bezpośrednio w CLI.

## 2. Stan obecny i luki

| Obszar | Jest | Brakuje |
|--------|------|---------|
| Worktree | wzmianka w [06-running.md §B3](06-running.md#b3-szkic-metator-run-drive) (`--worktree` w szkicu `run drive`) | zarządzania worktree, przydziału portów, sprzątania |
| Uruchamianie aplikacji | `discover` zna skrypty, menedżer pakietów i CI; `gate` uruchamia kroki z configu | modelu „jak wystartować aplikację”, zdrowia usług, pomiaru czasu, współdzielenia |
| Instalacja | `init` (propozycja `metator.config.yml`), `generate` (pliki hosta) | dostarczania kanonu agentów, skilli i workflowów z pakietu; wyboru hosta; aktualizacji |
| Prowadzenie runu | maszyna stanów (`run init|advance|approve`), hooki; etapy prowadzi koordynator LLM w hoście | procesu, który sam prowadzi etapy i uruchamia agentów (`run drive`, F5 odłożone) |
| Interakcja | koperta JSON dla agentów i skryptów | widoku dla człowieka (TTY), pytań w miejscu, listy sesji |

Wniosek: punkty 3–5 wymagają **odwrócenia sterowania**. Dziś host (Claude Code, Copilot) prowadzi run i woła `metator`. W trybie interaktywnym CLI `metator` prowadzi run i woła hosta jako silnik agentów (port `AgentHost`). Obie drogi korzystają z tej samej specyfikacji workflow, tych samych agentów, hooków i stanu runu, więc tryb w VS Code zostaje bez zmian.

## 3. Koncepcja

### 3.1 Instalacja: `metator setup`

```bash
metator setup                      # interaktywnie: host(y), workflowy, hooki, config
metator setup --host claude --workflows all --yes   # bez pytań (CI, skrypty)
metator agents update              # nowa wersja kanonu z pakietu, bez nadpisywania lokalnych zmian
```

- Kanon (`metator/agents`, `metator/skills`, `.github/metator/workflows`) jest **zasobem pakietu** `metator`. Nie kopiujemy go z checkoutu narzędzia.
- Kroki `setup`:
  1. `discover` i propozycja `metator.config.yml`, czyli to, co dziś robi `init`;
  2. wybór hostów, zapisany w configu jako `hosts: [claude-code, copilot]`;
  3. wybór workflowów (W1–W5);
  4. kopia kanonu;
  5. `generate` (opcjonalnie z `--hooks`);
  6. lint agentów, skilli i workflowów oraz `generate --check` jako dowód, że instalacja jest spójna (pełne `meta check-all` wymaga warstwy wiedzy, której świeże repo nie ma).
- **`metator/install.lock.json`** (dokument `InstallLock` v1) zapisuje wersję pakietu i hash każdego skopiowanego pliku. `agents update` nadpisuje tylko pliki niezmienione lokalnie. Zmienione pokazuje jako konflikt z diffem i proponuje `--theirs` albo `--keep`.
- Nazwa: zamiast `metator agents --gen` proponuję `setup` (całość) i `agents install|update` (sam kanon). `--gen` dubluje istniejące `generate`.

### 3.2 Worktree jako miejsce pracy runu

```bash
metator worktree new --run <id>    # git worktree add .metator/wt/<id> -b metator/<id>
metator worktree list              # worktree, run, branch, porty, stan środowiska, rozmiar
metator worktree rm <id>           # env down, git worktree remove, zwolnienie portów
```

- `run init --worktree` (domyślne w trybie interaktywnym) tworzy worktree i zapisuje go w runie (`RunRecord` v3: `worktree`, `host`, `hostSession`, `apps`; razem z `parent` i `children` z F7.6, w jednej migracji).
- **Porty:** każdy worktree dostaje blok portów zapisany w rejestrze `.metator/worktrees.json` (dokument `WorktreeRegistry` v1). `env up` przekazuje go procesom jako zmienne `METATOR_PORT_BASE` i `METATOR_PORT_COUNT`, bez plików `.env` w worktree. Do sprawdzenia, czy port jest wolny, używamy gotowego pakietu (`get-port`).
- Sprzątanie: `worktree prune` usuwa worktree zamkniętych runów starszych niż N dni. Nigdy nie usuwa worktree z niezapisanymi zmianami.

### 3.3 Środowisko aplikacji: wykrycie, konfiguracja, start

**Dokument `Environment` v1** (`metator/environment.yml`, w repo, przeglądany jak kod):

```yaml
kind: Environment
schemaVersion: 1
services:
  postgres:
    source: { compose: docker-compose.yml, service: db }
    scope: shared              # jedna instancja dla wszystkich worktree
    isolate: { postgres: { template: app_seed } }   # baza per worktree klonowana z szablonu
    health: { tcp: 5432 }
  kafka:
    source: { compose: docker-compose.yml, service: kafka }
    scope: shared
    isolate: { prefix: topic }  # prefiks topiców per worktree
  api:
    source: { script: "bun run --cwd apps/api dev" }
    scope: worktree             # uruchamiany w worktree runu
    needs: [postgres, kafka]
    ports: { http: 3000 }
    health: { http: "/health" }
    warm: { reuse: [node_modules, apps/api/dist], from: main }
  web:
    source: { script: "bun run --cwd apps/web dev" }
    scope: on-demand            # tylko gdy zmiana go dotyka albo użytkownik poprosi
    needs: [api]
profiles:
  backend: [api]                # `env up --profile backend` wystartuje też to, czego api potrzebuje
```

**Wykrywanie (`env discover`), jak dzisiejsze `discover`: fakty z dowodami i pewnością.**
- `docker-compose*.yml` / `compose*.yaml`: przez `docker compose config --format json` (gotowe narzędzie normalizuje profile, `extends` i zmienne). Dostajemy usługi, `depends_on`, healthchecki, porty i wolumeny.
- `.devcontainer/devcontainer.json`: `dockerComposeFile`, `postCreateCommand`, `forwardPorts`.
- `package.json` (workspaces): `dev`, `start`, `serve`; `Procfile`; cele `Makefile` (`run`, `dev`, `up`).
- Tiltfile, Skaffold, Helm chart: wykrywane jako sygnał, adaptery post-MVP.
- `.env.example`: zmienne do nakładki portów.
- Klasyfikacja usług:
  - obraz bazy, brokera albo cache (postgres, mysql, redis, kafka, rabbitmq, elasticsearch…) to `shared` z izolacją;
  - kod z repo to `worktree`;
  - frontend to `on-demand`.
- Brak pewnego wyniku: **`env init`** zadaje pytania (komenda startu, port, health, zależności) i zapisuje `metator/environment.yml`. Zatwierdzonego pliku nigdy nie nadpisuje; `env discover --check` w CI pokazuje rozjazd.

**Start (`env up`):**

```bash
metator env up                       # usługi potrzebne dla zmiany w bieżącym worktree
metator env up --profile backend     # profil z pliku
metator env up api web --worktree <id>
metator env status | logs <svc> | down
```

- Kolejność z grafu `needs` (graphlib, jak fale wdrożeń w F7). Gotowość z healthchecku, nigdy przez `sleep`. Proces i logi każdej usługi trafiają do `.metator/wt/<id>/env/` (dokument `EnvState` v1).
- **Tylko to, czego zmiana potrzebuje:**
  - `graph affected` w jednym repo;
  - `system impact` z F7 między aplikacjami;
  - do tego domknięcie `needs`.

  Reszta jest współdzielona albo nieuruchomiona.

### 3.4 Analiza startu i szybki start (`env analyze`)

`env analyze` mierzy prawdziwy zimny start raz, w tle, i zapisuje profil (`EnvProfile` v1):
- czas każdej fazy każdej usługi: pull, build, install, migracje, seed, gotowość;
- ścieżkę krytyczną w grafie `needs`;
- rekomendacje z szacowanym zyskiem, które człowiek zatwierdza do `environment.yml`.

Strategie, od największego zysku przy typowym backendzie:

| Strategia | Na czym polega | Typowy zysk | Ryzyko |
|-----------|----------------|-------------|--------|
| **Współdzielona infrastruktura** | jedna instancja bazy, brokera i cache dla wszystkich worktree (osobny projekt compose `metator-shared`) | znika pull, start i migracje infrastruktury | wycieki danych między runami, rozwiązane izolacją poniżej |
| **Izolacja danych zamiast osobnych kontenerów** | Postgres `CREATE DATABASE wt_<id> TEMPLATE app_seed` (sekundy), MySQL klon schematu, prefiks kluczy i topiców | seed i migracje bazowe raz, nie per worktree | migracje runu działają tylko na jego bazie, co jest pożądane |
| **Częściowy start** | tylko usługi z `affected`/`impact` i ich `needs`; reszta z instancji `shared` gałęzi głównej albo ze stage'a (`source: { url }`) | bez startu kilkunastu serwisów | niezgodność wersji między gałęziami; ostrzeżenie, gdy kontrakt się zmienił (F7.4) |
| **Ponowne użycie buildu** | `node_modules`, `dist`, `.gradle`, `target` z głównego checkoutu przez copy-on-write (`cp --reflink=auto`) albo cache menedżera; obrazy budowane raz na hash lockfile'a | install i build przyrostowo | cache nieaktualny po zmianie lockfile'a, dlatego klucz to hash |
| **Pula ciepłych worktree** | `env pool --size 2`: gotowe worktree z działającym środowiskiem na gałęzi głównej; nowy run bierze jedno i robi `git switch` | start w sekundach | koszt zasobów przy bezczynności; limit i TTL |
| **Snapshot danych** | wolumen z danymi po seedzie jako obraz albo zrzut (`pg_dump`/restore, snapshot wolumenu) | seed tylko raz | rozmiar; odświeżanie przy zmianie migracji |

Rekomendacja zawsze ma dowód: zmierzone czasy i powód, np. „`db` startuje 6 min, z czego 5 min to seed; template DB skraca to do ~3 s”. Szacunki sprawdza ponowny pomiar, nie obietnica.

> **Zrealizowane w F8.7 (ADR-0055):**
> - `Environment` v2: `paths`, `prepare`, `init`, `isolate`, `warm`;
> - `env analyze` z `EnvProfile` v1;
> - izolacja w Postgres przez szablon (port `DataIsolator`, klient wbudowany w Bun) i prefiksy;
> - `env up --affected`, `warm.reuse` (port `TreeCopier`, FICLONE);
> - `env pool`, z którego `run init --worktree` bierze wolny worktree.
>
> Snapshot danych, MySQL i obrazy na hash lockfile'a zostają na później.

### 3.5 Prowadzenie runu przez CLI: port `AgentHost` i `run drive`

- Port **`AgentHost`** w `core`: start agenta z promptem etapu i uprawnieniami workera, strumień zdarzeń (tekst, wywołanie narzędzia, pytanie, wynik), wznowienie sesji, przerwanie. Adaptery w pluginach:
  - `plugin-claude-code`: Claude Agent SDK (`query()` ze strumieniem wiadomości). Pytania i zgody przychodzą przez `canUseTool` i AskUserQuestion. Wznowienie przez `resume` z zapisanym id sesji. Te same agenci i hooki z `.claude/`.
  - `plugin-copilot-cli`: `copilot -p … --agent <worker>` z `--allow-tool`/`--deny-tool`, transkrypt przez `--share` (flagi do potwierdzenia jak w F0).
  - Kontrakt portu w `packages/testing`, plus adapter testowy (agent-skrypt) do e2e bez LLM.
- **`run drive`** realizuje szkic z [06-running.md §B3](06-running.md#b3-szkic-metator-run-drive):
  - etap skryptowy: bezpośrednio;
  - etap agentowy: przez `AgentHost`, z pulą dla `parallel`;
  - etap HITL: pytanie do człowieka.

  Walidacja artefaktów i `run advance` zostają bez zmian, więc pętle, limity i eskalacje pilnuje ta sama maszyna stanów.
- **Aktywność runu** (`activity.jsonl`, dokument `RunActivity` v1, jedna linia na zdarzenie; nazwa `RunEvent` jest już zajęta przez zdarzenia maszyny stanów) i **pytania** (`questions/<id>.json`, dokument `Question` v1, odpowiedź w tym samym pliku). Komunikacja przez pliki w `.metator/runs/<id>/`: proces drive i UI mogą się niezależnie zamknąć i wrócić. Daemon nie jest potrzebny w MVP.
- Proces drive działa **odłączony** (`detached`, pid w runie). Zamknięcie terminala nie zatrzymuje runu; stop jest jawny (`run stop`).

### 3.6 Interaktywny `metator run` i `run continue`

```bash
metator run                         # TTY: wybór workflowu, opis zadania, autonomia → widok na żywo
metator run --workflow mt-feature --task "Add combined discount" --host claude
metator run continue                # lista: czeka na mnie, przerwane, eskalowane → wybór → widok na żywo
metator run continue <id>
```

- Widok na żywo:
  - pasek etapów (ten sam model co diagram na stronie);
  - bieżący agent i jego ostatnie kroki (narzędzia, pliki);
  - wynik bramek;
  - licznik pętli.
- Pytanie albo bramka HITL wyświetla się w miejscu z numerowanymi opcjami, takimi jak w czacie hosta. Odpowiedź trafia do `Question`, a drive jedzie dalej. Odrzucenie planu z komentarzem wraca do plannera.
- Kontrakt maszynowy się nie zmienia: bez TTY albo z `--json` komendy zwracają kopertę JSON. Widok jest tylko klientem plików runu.
- `run continue` wznawia drive i sesję hosta (`hostSession`), jeśli host to wspiera. W przeciwnym razie startuje świeżego agenta z `handoff.md`.

### 3.7 `metator ui`: sesje w terminalu

```
┌ sessions ──────────────────────┐┌ run 2026-10-27-discount · mt-feature · L1 · claude ─────────┐
│ ● discount     build  2/5   ⟳  ││ intake ✓ scope ✓ plan ✓ [build ⟳] review · deliver          │
│ ? auth-fix     plan gate    !  ││ mt-implementer  S3 packages/billing/src/discount.ts          │
│ ✓ docs-links   done            ││   edit  discount.ts (+42 −3)   test  billing.test.ts ✗ → ✓   │
│ ✗ refactor-x   escalated       ││ apps: api ● :3104  web ○  postgres ● shared                  │
└────────────────────────────────┘└──────────────────────────────────────────────────────────────┘
 n new run  ⏎ attach  tab switch  q questions (1)  a apps  o open  t shell  d diff  s stop
```

- Lewy panel: sesje (runy) ze statusem: pracuje, **czeka na mnie**, błąd, eskalacja, gotowe. Prawy panel: widok na żywo z §3.6.
- **Skrzynka pytań** (`q`): wszystkie otwarte `Question` ze wszystkich sesji, z kontekstem (etap, artefakt, diff). Opcjonalnie dzwonek terminala i powiadomienie systemowe.
- **Aplikacje sesji** (`a`): usługi z `Environment` dla worktree runu. Stan, porty i URL, start, stop, restart, logi na żywo. „Otwórz w przeglądarce” dla usług HTTP.
- **Kod:**
  - `o` otwiera worktree w edytorze (`$VISUAL`, `$EDITOR`, albo `editor` z configu: `code`, `cursor`, `idea`, `zed`, `nvim`);
  - `t` otwiera powłokę w worktree;
  - `d` pokazuje diff runu w CLI (`git diff` przez `delta`, gdy jest zainstalowany);
  - `f` przegląda pliki (`fzf` + `bat`, gdy są; bez nich prosta lista).
- `n` uruchamia kreator z §3.6 w nowym worktree. Wiele sesji działa równolegle, każda w swoim worktree i ze swoimi portami.

> **Zrealizowane w F8.6 (ADR-0054)** jako hub z menu na `@clack/prompts` w `packages/cli`, bez osobnego `packages/tui` i bez układu paneli: lista sesji, menu sesji, skrzynka pytań i dzwonek. Przeglądarka plików (`f`) i `delta` zostały poza zakresem; diff to `git diff`.

### 3.8 Gotowe narzędzia zamiast własnego kodu (ADR-0010)

| Potrzeba | Kandydat | Uwagi |
|----------|----------|-------|
| UI terminala | **Ink** (React dla CLI) + `ink-testing-library` | dojrzały, używany przez duże CLI agentowe; testy komponentów bez TTY |
| Kreatory i pytania (`setup`, `env init`) | `@clack/prompts` | lekki; alternatywa `@inquirer/prompts` |
| Procesy usług | `execa` | sygnały, drzewo procesów, strumienie |
| Gotowość usług | `wait-on` (tcp, http) | zamiast własnych pętli |
| Porty | `get-port` | wolny port z bloku |
| Compose | CLI `docker compose` (MVP: tylko Docker) | `config --format json`, `up --wait`, projekty per worktree |
| Agenci | Claude Agent SDK, Copilot CLI | adaptery `AgentHost` |
| Worktree | `git worktree` przez istniejący adapter git (simple-git) | bez własnej logiki git |
| Test e2e TUI | `node-pty` / `Bun.Terminal` + `@xterm/headless` | prawdziwy proces w pseudo-terminalu, asercje na ekranie |

Każda zależność trafia do `docs/metator/dependencies.yml` z ADR, a wybór jest potwierdzany spike'iem (na przykład zgodność Ink i node-pty z Bun).

## 4. Nowe elementy (zakres)

| Element | Rodzaj | Opis |
|---------|--------|------|
| `setup`, `agents install|update` | CLI + use case | instalacja kanonu z pakietu, wybór hostów, `InstallLock` v1 |
| `worktree new|list|rm|prune` | CLI + porty `WorktreeManager`, `PortProbe` | worktree runu, `WorktreeRegistry` v1 z blokami portów |
| `Environment` v1, `EnvState` v1, `EnvProfile` v1 | dokumenty | konfiguracja, stan i profil startu |
| `env discover|init|up|down|status|logs|analyze|pool` | CLI + port `EnvironmentRunner` | adaptery `compose`, `process`; post-MVP `devcontainer`, `tilt`, `k8s` |
| port `ServiceDetector` | port + pluginy | compose, devcontainer, skrypty, Procfile, Makefile |
| port `DataIsolator` | port + pluginy | MVP: Postgres (template), prefiks (redis, kafka) |
| port `AgentHost` | port + pluginy | `plugin-claude-code`, `plugin-copilot-cli`, adapter testowy |
| `run drive|stop|continue`, interaktywny `run` | CLI + use case | prowadzenie etapów, `RunEvent` v1, `Question` v1, `RunRecord` v3 |
| `packages/tui` + `metator ui` | pakiet (warstwa jak `cli`) | Ink; czyta tylko pliki runu i woła use case'y z `runtime` |
| hosty w configu | `metator.config.yml` v3 | `hosts`, `editor`, `env.pool`, `worktree.root` |

Architektura zostaje nienaruszona:
- porty w `core`, adaptery w pluginach, składanie w `runtime`;
- `tui` to drugi klient obok `cli`, z tymi samymi regułami ast-grep (nie zna adapterów).

## 5. Roadmapa (faza F8: sesje, worktree i środowiska)

| Etap | Cel | Produkty | Kryterium wyjścia |
|------|-----|----------|-------------------|
| **F8.1 Instalacja** | jedna komenda zamiast kopiowania | kanon jako zasób pakietu, `setup`, `agents install|update`, `InstallLock` v1, `hosts` w configu | e2e: puste repo → `setup --host claude --yes` → lint agentów, skilli, workflowów i `generate --check` zielone; update nie nadpisuje lokalnej zmiany |
| **F8.2 Worktree** | run nie dotyka mojego working tree | `WorktreeManager`, `PortProbe`, `worktree *`, `WorktreeRegistry` v1, `run init --worktree`, `RunRecord` v3 | e2e: dwa runy w dwóch worktree z rozłącznymi portami; `rm` odmawia przy niezapisanych zmianach |
| **F8.3 `AgentHost` i `run drive`** | CLI prowadzi etapy | port + kontrakt, adapter testowy, `plugin-claude-code`, `plugin-copilot-cli`, `RunEvent` v1, `Question` v1, `run stop` | e2e z adapterem testowym: W1 od intake do HITL planu; spike na prawdziwym hoście |
| **F8.4 Interaktywny run** | widzę proces i odpowiadam w miejscu | `metator run` (TTY), `run continue`, wznowienie sesji hosta | e2e w pseudo-terminalu: start → pytanie → odpowiedź → następny etap; `continue` po zabiciu procesu |
| **F8.5 Środowisko: wykrycie i start** | MetatorAI wie, jak uruchomić aplikację | `Environment` v1, `ServiceDetector` (compose, skrypty, devcontainer, Procfile, Makefile), `env discover|init|up|down|status|logs` | e2e: repo z compose (postgres + api) i repo ze skryptami wykryte i uruchomione; nieznane → `env init` |
| **F8.6 Sesje w UI** | przełączam sesje, widzę pytania i aplikacje | `packages/tui`, `metator ui`: sesje, skrzynka pytań, aplikacje, edytor, powłoka, diff | e2e w pseudo-terminalu: dwie sesje, przełączenie, odpowiedź na pytanie z drugiej, start aplikacji |
| **F8.7 Analiza i szybki start** | nie czekam 20 minut | `env analyze`, `EnvProfile` v1, `DataIsolator` (Postgres, prefiksy), częściowy start z `affected`/`impact`, reuse buildu, `env pool` | na repo z wolnym seedem: drugi worktree startuje ≥ 10× szybciej niż zimny start, zmierzone i zapisane w profilu |

Zależności:
- F8.1 jest niezależne i daje szybką wartość, więc idzie pierwsze;
- F8.2 → F8.3 → F8.4 → F8.6;
- F8.5 może iść równolegle po F8.2, a F8.7 po F8.5;
- częściowy start między aplikacjami korzysta z F7.3 (`system impact`).

F8.3 przejmuje sedno odłożonego F5 (`run drive`). CI i nightly z F5 zostają w F5.

## 6. Plan realizacji (etapy implementacji w tym repo)

Każdy etap kończy się tak jak w [08-system-landscape.md §6](08-system-landscape.md#6-plan-realizacji-etapy-implementacji-w-tym-repo), a dodatkowo każdy nowy port przechodzi swój kontrakt w `packages/testing`.

1. **S1 (F8.1):**
   - `packages/cli` publikuje kanon jako zasoby (`files` w package.json) i ma resolver ścieżki zasobów;
   - use case `InstallCanon` (kopia, hash, konflikty) na porcie `FileStore`;
   - kreator na `@clack/prompts`, a bez TTY wymagane flagi;
   - `init` zostaje jako sam config, a `setup` go woła.
2. **S2 (F8.2):** port `WorktreeManager` (adapter na simple-git), dzierżawy portów (`get-port`), migracja `RunRecord` v2 → v3, sprzątanie z ochroną niezapisanych zmian.
3. **S3 (F8.3):**
   - Port `AgentHost` i kontrakt.
   - Adapter testowy: „agent” czytający scenariusz YAML, który pisze artefakty i zadaje pytania.
   - Use case `DriveRun` (pętla etapów, pula, walidacja, `advance`) i zdarzenia oraz pytania jako dokumenty.
   - Spike adapterów prawdziwych hostów i nagranie zachowania (uprawnienia, hooki, wznowienie).
4. **S4 (F8.4):**
   - Komponenty Ink: pasek etapów, strumień zdarzeń, pytanie.
   - `run` bez podkomendy w TTY, `run continue`.
   - e2e w pseudo-terminalu.
5. **S5 (F8.5):**
   - Detektory jako pluginy, wynik z dowodami jak w `discover`.
   - `EnvironmentRunner` z adapterami `compose` (projekt per worktree i wspólny `metator-shared`) oraz `process` (`execa`, `wait-on`).
   - e2e z compose uruchamiane, gdy Docker jest dostępny; w przeciwnym razie adapter `process` na prawdziwych procesach.
6. **S6 (F8.6):** `packages/tui` (reguły architektury: tylko `runtime` i `core`), panele, akcje edytora i powłoki z configu, e2e w pseudo-terminalu.
7. **S7 (F8.7):**
   - pomiar faz;
   - ścieżka krytyczna;
   - rekomendacje z dowodem;
   - `DataIsolator` dla Postgresa (template), prefiksy;
   - reuse przez `cp --reflink=auto` z fallbackiem;
   - pula z limitem i TTL.

## 7. Przykład: od zera do sesji z aplikacjami

```bash
metator setup                        # host: Claude Code; workflowy: wszystkie; hooki: tak
metator env discover                 # compose: postgres, kafka (shared); api (worktree); web (on-demand)
metator env analyze                  # zimny start 19m40s; seed 14m → template DB; build api 3m → reuse
metator ui                           # n → mt-feature "Add combined discount" → run w .metator/wt/…
#   plan gate: "? Approve plan (5 steps, scope: packages/billing)"  → 1. Approve
#   a → api ● :3104 (start 21 s: shared postgres + baza wt_discount z template)
#   o → otwiera worktree w Cursor; d → diff runu w terminalu
metator run continue                 # następnego dnia: wybór "auth-fix (czeka na review gate)"
```

## 8. Decyzje (2026-10-27)

1. **Hosty:** Claude Code (Agent SDK) i Copilot CLI **razem** w F8.3, oba za portem `AgentHost` z tym samym kontraktem. Wybór hosta w `setup` i per run (`--host`).
2. **Runy w tle:** run działa dalej po zamknięciu terminala. Proces jest odłączony, komunikacja idzie przez pliki runu, bez daemona.
3. **Współdzielona infrastruktura** jest domyślna dla baz i brokerów, z obowiązkową izolacją danych (MVP: Postgres template, prefiksy dla Redis i Kafka). Usługa bez izolatora idzie jako `worktree`.
4. **Kontenery:** w MVP **tylko Docker** (`docker compose`). Podman, devcontainer, Tilt i Kubernetes są post-MVP.
5. **Nazwy komend:** `metator setup` oraz `agents install|update`.
6. **Edytor:** kreator wykrywa zainstalowane edytory (VS Code, Cursor, JetBrains, Zed, nvim i inne z `PATH`) i daje wybór z listy; wynik trafia do configu jako `editor`. Bez wyboru działa `$VISUAL`, potem `$EDITOR`, potem pierwszy wykryty edytor.

## 9. Ryzyka

| Ryzyko | Skutek | Ograniczenie |
|--------|--------|--------------|
| Złe wykrycie startu | aplikacja nie wstaje albo wstaje źle | dowody i pewność; niepewne → `env init` z pytaniami; zatwierdzony plik w repo |
| Współdzielona infrastruktura miesza dane runów | fałszywe wyniki testów | izolacja danych obowiązkowa dla `shared`; bez izolatora usługa idzie jako `worktree` |
| Zasoby (wiele worktree, pula) | pełny dysk, RAM | limity `env.pool`, TTL, `worktree prune`, `worktree list` z rozmiarem |
| Zmiany API hostów (SDK, flagi CLI) | drive przestaje działać | adaptery za portem, kontrakt w testach, spike przed każdą wersją hosta |
| Pytania agenta poza HITL | run stoi bez wiedzy człowieka | każde pytanie to `Question` w skrzynce, status sesji „czeka na mnie”, powiadomienie |
| TUI trudne do testowania | regresje widoku | logika w use case'ach (testy unit), komponenty przez `ink-testing-library`, e2e w pseudo-terminalu |
| Bezpieczeństwo procesów odłączonych | agent działa bez nadzoru | te same hooki, `guard`, zgody na push i komentarze; `run stop`; limity czasu i pętli ze spec |
