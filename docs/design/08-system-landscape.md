# Krajobraz systemu: zmiany w wielu aplikacjach (analiza i plan)

Status: **zaakceptowany kierunek, decyzje w sekcji 7** (2026-10-26). MVP: tylko OpenAPI; reszta w sekcji 9 (post-MVP).

## 1. Problem

Dziś MetatorAI rozumie **jedno repozytorium**. W jego granicach wie dużo:
- graf importów i krawędzie między pakietami monorepo (`graph *`);
- symbole i API pakietu (`symbols find`, `api snapshot|diff`);
- karty modułów, właścicieli (CODEOWNERS), reguły i wzorce;
- przebieg pracy w runie (W1–W5).

Typowe zadanie w organizacji dotyka jednak **kilku aplikacji**. Przykład: „dodaj rabat łączony do faktur” wymaga zmian w:
- frontendzie (formularz);
- BFF/API gateway (nowe pole);
- serwisie billing (logika i migracja bazy);
- serwisie notyfikacji (nowe zdarzenie);
- bibliotece współdzielonej (typ `Discount`).

Agent musi wtedy wiedzieć:
1. **Gdzie:** które aplikacje i które ich moduły dotyka zmiana.
2. **Przez co:** jakim kontraktem są połączone (HTTP/OpenAPI, zdarzenia, GraphQL, gRPC, wspólna baza, pakiet npm z wersją, konfiguracja, flagi).
3. **Jak:** czy zmiana kontraktu jest zgodna wstecz, a jeśli nie, to jaką strategią ją wprowadzić (expand → migrate → contract, wersjonowanie, flaga).
4. **W jakiej kolejności:** które PR-y i wdrożenia muszą iść pierwsze (dostawca przed konsumentem, migracja przed kodem).
5. **Kto:** właściciel każdej aplikacji i kontraktu (eskalacja, review).
6. **Czym sprawdzić:** testy kontraktowe, diff kontraktu, testy e2e między aplikacjami.

Bez tej wiedzy agent zgaduje z kodu jednej aplikacji i zwykle pomija konsumenta albo kolejność wdrożenia.

## 2. Stan obecny i luki

| Potrzeba | Co już jest | Luka |
|----------|-------------|------|
| Mapa aplikacji | pakiety monorepo (`workspace list`), karty | brak pojęcia **aplikacji** (jednostki wdrożenia) i aplikacji w innych repo |
| Powiązania | krawędzie importów między pakietami | brak powiązań **runtime**: HTTP, zdarzenia, baza, wersjonowane pakiety |
| Wpływ zmiany | `graph affected` (pliki i testy w repo) | brak `system impact`: zmiana → kontrakt → konsumenci w innych aplikacjach |
| Zgodność | `api diff` (deklaracje TS pakietu) | brak diffu kontraktów (OpenAPI, AsyncAPI, proto, GraphQL) z klasą zmiany |
| Plan | `Plan` dla jednego repo, `plan lint` | brak planu systemowego: podplany per aplikacja, kolejność, strategia zmiany łamiącej |
| Wykonanie | run w jednym repo, handoff, zgody | brak runów powiązanych (rodzic/dzieci) w wielu repo |
| Właściciele | CODEOWNERS w repo | brak właściciela aplikacji i kontraktu na poziomie systemu |
| Bramki | `gate quick|full` w repo | brak bramki kontraktowej (breaking bez strategii → FAIL) |

Wniosek: podstawy działają w jednym repo. Brakuje **jednej warstwy wyżej**, czyli deklaratywnego opisu systemu i komend, które go czytają.

## 3. Koncepcja

### 3.1 Dokument `SystemMap` (konfiguracja krajobrazu)

Wersjonowany dokument (ADR-0016), zatwierdzany przez człowieka jak canon. Domyślnie leży w `docs/metator/system.yml`. Może też być w repo „platformy” i być czytany przez każde repo w przypiętej wersji (pytanie otwarte, sekcja 7).

```yaml
kind: SystemMap
schemaVersion: 1
system: billing-platform
applications:
  - id: web
    kind: frontend
    source: { repo: github.com/acme/web }        # albo { path: apps/web } w monorepo
    owners: ["@acme/web-team"]
    deploy: { unit: web, environments: [dev, staging, prod] }
    consumes: [billing-api@^2, ui-kit@^5]
  - id: billing
    kind: service
    source: { repo: github.com/acme/billing }
    owners: ["@acme/billing-team"]
    provides: [billing-api, invoice-issued]
    consumes: [billing-db]
  - id: notifications
    kind: service
    source: { repo: github.com/acme/notifications }
    consumes: [invoice-issued@1]
contracts:
  - id: billing-api
    kind: openapi                 # openapi | asyncapi | graphql | proto | npm | db-schema | config
    owner: billing
    spec: { app: billing, path: openapi/billing.yaml }
    compatibility: backward       # backward | forward | full | none
  - id: invoice-issued
    kind: asyncapi
    owner: billing
    spec: { app: billing, path: asyncapi/invoice.yaml }
  - id: billing-db
    kind: db-schema
    owner: billing
    spec: { app: billing, path: migrations/ }
  - id: ui-kit
    kind: npm
    package: "@acme/ui-kit"
policies:
  deployOrder: providers-first    # dostawca kontraktu wdraża się przed konsumentem
  breaking: expand-contract       # zmiana łamiąca: najpierw rozszerz, migruj konsumentów, potem usuń
```

Przykład pokazuje model docelowy. W MVP rejestr pluginów zna tylko `kind: openapi`; inne rodzaje (sekcja 9) `system lint` odrzuca z podpowiedzią.

Zasady:
- **Aplikacja** to jednostka wdrożenia (repo albo katalog w monorepo), nie pakiet. Pakiety zostają w kartach modułów.
- **Kontrakt** to krawędź systemu: ma właściciela, specyfikację (plik u dostawcy), klasę zgodności i wersję oczekiwaną przez konsumenta.
- Mapa jest **deklaracją**: `system discover` proponuje szkic z kodu, człowiek go zatwierdza, a `system lint` pilnuje, żeby mapa zgadzała się z kodem (sekcja 3.3).

### 3.2 Jak agent analizuje zadanie (nowy etap „system impact”)

```
zadanie ─► mt-system-scout
             1. metator system impact --task / --contracts / --files
                → aplikacje i kontrakty dotknięte zmianą, konsumenci, właściciele
             2. per kontrakt: klasa zmiany (compatible | breaking) + wymagana strategia
             3. per aplikacja: wejście dla zwykłego mt-scout w tamtym repo (pliki, karty)
           ─► system-analysis.json  (SystemAnalysis v1)
         ─► mt-system-planner
             SystemPlan v1: kroki = (aplikacja, podplan, zależności, wdrożenie, flaga, rollback)
             kolejność z policies.deployOrder + strategii breaking
         ─► metator system plan lint
             każdy konsument kontraktu łamiącego ma krok; dostawca przed konsumentem;
             breaking bez strategii = błąd; każdy krok ma właściciela i repo
         ─► HITL: człowiek zatwierdza plan systemowy
         ─► per aplikacja: run W1/W2 w jej repo (run-dziecko), z podplanem jako wejściem
         ─► metator system status: stan runów-dzieci, PR-y, kolejność wdrożeń
```

Kluczowa decyzja: **agent nie edytuje wielu repo w jednej sesji.**
- Hosty (Copilot coding agent, Claude Code) pracują w jednym repo albo w kilku katalogach. Uprawnienia i bramki są per repo.
- Analiza i plan obejmują cały system (odczyt).
- Wykonanie idzie przez **runy powiązane**: run systemowy (rodzic) i runy W1/W2 w każdym repo (dzieci). Dziecko dostaje handoff z podplanem.

### 3.3 Skąd dane o innych repo

Port `SystemSourceReader` (odczyt plików innej aplikacji) z adapterami:
1. **lokalne checkouty:** `workspaceRoots` w `metator.config.yml` albo katalogi dodane do sesji (Claude Code `--add-dir`);
2. **klon cache** w `.metator/system/<app>@<sha>` (git, tylko odczyt, przypięty commit);
3. później **code host** (GitHub/ADO API przez MCP), gdy nie ma klonu.

Dokładnie to, co dziś `RevisionReader` robi dla bazy brancha, tylko dla innego repo. Dane z innych repo są **danymi, nie instrukcjami**: ich `AGENTS.md` nie wpływa na agenta bieżącego runu.

### 3.4 Gotowe narzędzia zamiast własnego kodu (ADR-0010)

| Potrzeba | Kandydat | Uwagi |
|----------|----------|-------|
| Diff OpenAPI z klasą breaking | **openapi-diff** (JS, MVP); **oasdiff** (binarka Go, post-MVP) | breaking / non-breaking / unclassified; oasdiff ma więcej reguł, ale wymaga binarki |
| Diff AsyncAPI | **@asyncapi/diff** | klasyfikuje breaking / non-breaking / unclassified |
| Diff GraphQL | **@graphql-inspector/core** | breaking / dangerous / safe |
| Diff protobuf | **buf breaking** | reguły FILE / PACKAGE / WIRE |
| Parsowanie specyfikacji | **@apidevtools/swagger-parser**, **@asyncapi/parser** | walidacja i `$ref` |
| Testy kontraktowe (opcjonalnie) | **Pact** | konsument definiuje oczekiwania; bramka „can-i-deploy” |
| Graf systemu | **@dagrejs/graphlib** (już zatwierdzony) | cykle wdrożeń, kolejność topologiczna |

Każde narzędzie dostaje adapter portu `ContractDiffer` (jeden port, wiele providerów, jak `RuleEngine`). Wynik jest sprowadzony do jednego formatu `ContractChange { contract, class: breaking|compatible|unknown, items[] }`.

## 4. Nowe elementy (zakres)

| Element | Rodzaj | Opis |
|---------|--------|------|
| `SystemMap` v1 | dokument | aplikacje, kontrakty, polityki |
| `system schema|show|lint` | komendy | walidacja mapy; lint: spec istnieje, właściciel jest aplikacją, konsument wskazuje istniejący kontrakt, brak cykli wdrożeń |
| `system discover` | komenda | szkic mapy z kodu: specyfikacje OpenAPI/AsyncAPI/proto/GraphQL, zależności od wewnętrznych pakietów, `docker-compose`, manifesty k8s/helm, zmienne środowiskowe z adresami usług |
| `SystemSourceReader` | port | odczyt plików aplikacji (checkout lokalny, cache klonu) |
| `ContractDiffer` | port | adaptery oasdiff, @asyncapi/diff, graphql-inspector, buf |
| `system impact` | komenda | pliki/kontrakty/zadanie → kontrakty, konsumenci, właściciele, klasa zmiany |
| `contract diff <id>` | komenda | diff kontraktu bazy brancha vs working tree, klasa zmiany |
| `SystemAnalysis` v1, `SystemPlan` v1 | dokumenty | artefakty runu systemowego |
| `system plan lint` | komenda | kolejność, strategia breaking, pokrycie konsumentów, właściciele |
| runy powiązane | rozszerzenie `RunRecord` (v3) | `parent`/`children`, `system status`, handoff do runu-dziecka |
| W13 `mt-system-change` | workflow | system-scout → system-planner → plan lint → HITL → runy-dzieci → system status → delivery |
| `mt-system-scout`, `mt-system-planner` | agenci | analiza i plan na poziomie systemu (tylko odczyt kodu innych repo) |
| bramka kontraktowa | krok `gate full` | `contract diff` każdego dostarczanego kontraktu; breaking bez wpisu w planie = FAIL |
| karty aplikacji | rozszerzenie kart | blok generowany: kontrakty dostarczane/konsumowane, właściciele, konsumenci |

## 5. Roadmapa (faza F7: system wielu aplikacji)

MVP obejmuje jeden rodzaj kontraktu (**OpenAPI**) i automatyczne wykrywanie topologii. Wszystkie rodzaje kontraktów idą przez jeden mechanizm pluginów, więc kolejne (sekcja 9) to nowe adaptery, a nie zmiany w rdzeniu.

| Etap | Cel | Produkty | Kryterium wyjścia |
|------|-----|----------|-------------------|
| **F7.1 Mapa systemu** | agent wie, jakie są aplikacje i kontrakty | `SystemMap` v1, `system schema|show|lint`, rejestr rodzajów kontraktów (plugin OpenAPI), ADR | mapa przykładowego systemu przechodzi `system lint`; nieznany rodzaj kontraktu to błąd z podpowiedzią |
| **F7.2 Topologia i discovery** | MetatorAI sam rozpoznaje monorepo albo osobne repo, aplikacje i specyfikacje OpenAPI | `system discover` (propozycja mapy z dowodami i pewnością), port `ContractDetector` | e2e: monorepo z 3 aplikacjami i 3 osobne repo dają poprawną propozycję |
| **F7.3 Źródła i wpływ zmiany** | „gdzie i przez co” | port `SystemSourceReader` (lokalny checkout, klon do cache), mapa w repo platformy przypięta w aplikacjach, `system impact` | e2e na kilku prawdziwych repo: impact wskazuje dostawcę, konsumentów i właścicieli |
| **F7.4 Zgodność OpenAPI** | „jak”: zmiana łamiąca czy nie | port `ContractDiffer`, provider OpenAPI (`openapi-diff`), `contract diff`, krok bramki w `gate full` | łamiąca zmiana wykryta, zgodna przechodzi; brak providera = `unknown`, nie FAIL |
| **F7.5 Plan systemowy** | „w jakiej kolejności i kto” | `SystemAnalysis`, `SystemPlan`, `system plan lint`, agenci `mt-system-scout`, `mt-system-planner`, karty aplikacji | lint wymusza: dostawca przed konsumentem, strategia dla zmiany łamiącej, krok dla każdego konsumenta |
| **F7.6 Wykonanie powiązane** | realizacja w wielu repo | `RunRecord` v3 (rodzic i dzieci), `system status`, handoff do runu-dziecka, W13 `mt-system-change` | e2e: run systemowy z dwoma runami-dziećmi w dwóch repo |
| **F7.7 Evale** | mierzona trafność | przypadki wieloaplikacyjne w złotym zbiorze, score impact i planu | na pilocie: impact ≥ 95% aplikacji, plan bez zmian kolejności dla 5 zadań |

Zależności: F7.1 → F7.2 → F7.3 → F7.4 → F7.5 → F7.6 → F7.7. F7.1–F7.6 da się zrobić i przetestować w tym repo (e2e na prawdziwych repo git w katalogu tymczasowym). F7.7 wymaga danych z pilota.

## 6. Plan realizacji (etapy implementacji w tym repo)

Każdy etap kończy się tak jak dotąd:
- testy unit i e2e na prawdziwych repo w katalogu tymczasowym;
- mutanty;
- zamrożone schematy;
- ADR jako Proposed;
- `bun run check`, commit i push.

1. **S1: `SystemMap` i rejestr kontraktów.**
   - Domena: schemat zod; walidacja referencji (konsument → kontrakt, właściciel → aplikacja, źródło: `path` w tym repo albo `repo` + opcjonalny `ref`); graf wdrożeń na graphlib (cykle, kolejność topologiczna).
   - Rodzaj kontraktu to id providera z rejestru pluginów; MVP rejestruje `openapi`.
   - Use case `SystemCatalog`; CLI `system schema|show|lint`; pozycja w mapie pamięci.
   - `system lint` w `meta check-all`, gdy mapa istnieje.
2. **S2: topologia i `system discover`.**
   - Port `ContractDetector` (provider OpenAPI: plik YAML/JSON z kluczem `openapi: 3.x` albo `swagger: 2.0`, parsowanie przez `@apidevtools/swagger-parser`).
   - Detekcja topologii:
     - repo z workspace'ami i kilkoma aplikacjami to **monorepo**;
     - repo-aplikacja z sąsiednimi checkoutami (`system.roots`) albo źródłami w mapie to **osobne repo**;
     - aplikacja to pakiet albo repo z sygnałem wdrożenia (`Dockerfile`, skrypt `start`, chart, specyfikacja API).
   - Konsumenci: zależność od pakietu klienta wygenerowanego ze specyfikacji, referencja do pliku specyfikacji, host z `servers[].url` w kodzie albo konfiguracji (pewność `low`, do zatwierdzenia).
   - Wynik to propozycja `SystemMap` z `evidence` i `confidence`; zatwierdzonej mapy nigdy nie nadpisuje.
3. **S3: `SystemSourceReader` i mapa z repo platformy.**
   - Adaptery: lokalny katalog (`system.roots` w `metator.config.yml`) i klon do `.metator/system/<app>@<sha>` (simple-git, tylko odczyt, przypięty commit).
   - Wybór adaptera zależy od użycia: lokalny checkout, gdy istnieje; klon, gdy go nie ma albo gdy wymagany jest przypięty `ref` (CI, review).
   - `metator.config.yml` wskazuje mapę: `system.map: { path }` albo `{ repo, ref, path }`.
   - Kontrakt portu w `packages/testing`.
4. **S4: `system impact`.** Zmienione pliki (`--base`/`--files`) albo `--contracts` → kontrakty, których specyfikacja lub implementacja się zmieniła → konsumenci → właściciele i źródła. Wynik `SystemImpact`.
5. **S5: `ContractDiffer` i `contract diff`.**
   - Provider OpenAPI na `openapi-diff` (JS, klasy breaking / non-breaking / unclassified). ADR z porównaniem z `oasdiff` (binarka Go; opcjonalny provider później).
   - Spec z bazy brancha vs working tree; wynik `ContractChange`.
   - Krok `contract diff` w `gate full`: zmiana łamiąca bez wpisu w planie to FAIL.
6. **S6: plan systemowy.**
   - Dokumenty `SystemAnalysis` i `SystemPlan`, `system plan lint`.
   - Agenci `mt-system-scout`, `mt-system-planner`; karty aplikacji z kontraktami.
7. **S7: runy powiązane i W13.**
   - `RunRecord` v3 z migracją (`parent`, `children`); `run init --parent <run> --app <id>`; `system status`; handoff do runu-dziecka z podplanem.
   - Spec W13 z pełną anatomią.
8. **S8: evale.** Format przypadków wieloaplikacyjnych (oczekiwane aplikacje, kontrakty, kolejność) i score.

## 7. Decyzje (2026-10-26)

1. **Topologia:** MetatorAI wykrywa ją sam (monorepo czy osobne repo); konfiguracja tylko nadpisuje wynik detekcji.
2. **Rodzaje kontraktów:** przez pluginy. Provider jest wybierany w konfiguracji albo wykrywany automatycznie (preferowane). **MVP: tylko OpenAPI**; pozostałe rodzaje w sekcji 9.
3. **Miejsce mapy:** jedno repo „platformy”, a repo aplikacji wskazują je w przypiętej wersji (`repo` + `ref`).
4. **Wdrożenia:** na start deklaracja w mapie (`deploy`, `policies.deployOrder`); odczyt z pipeline'ów w sekcji 9.
5. **Dostęp do innych repo:** lokalne checkouty i klonowanie, zależnie od użycia (lokalna praca: checkout; CI i przypięta wersja: klon).

## 8. Ryzyka

| Ryzyko | Skutek | Ograniczenie |
|--------|--------|--------------|
| Mapa rozjeżdża się z kodem | agent planuje na nieaktualnych danych | `system lint` w CI każdego repo, `system discover --check` w nightly W10 |
| Kontrakty bez specyfikacji (zdarzenia „z kodu”) | impact nie widzi konsumenta | heurystyki discover (nazwy topiców, klienci HTTP) jako `confidence: low` + HITL |
| Za duży kontekst przy wielu repo | koszt, halucynacje | do agenta trafia tylko wynik `system impact` (top-k), nie kod innych repo |
| Uprawnienia między repo | agent zmienia cudze repo | wykonanie tylko przez runy-dzieci w repo właściciela, z jego bramkami i zgodami |
| Narzędzia diffu w innych językach (Go, buf) | instalacja w CI | adaptery wywołują binarkę przez `BinResolver`; brak binarki = `unknown`, nie FAIL |

## 9. Post-MVP (do zrobienia później)

- [ ] Kontrakty zdarzeń: AsyncAPI (`@asyncapi/parser`, `@asyncapi/diff`), w tym zdarzenia bez specyfikacji (heurystyki topiców).
- [ ] GraphQL (`@graphql-inspector/core`).
- [ ] gRPC/protobuf (`buf breaking`).
- [ ] Pakiety npm jako kontrakt (wersja semver, `api diff` dostawcy).
- [ ] Schemat bazy jako kontrakt (migracje, wspólna baza).
- [ ] Konfiguracja i flagi funkcji jako kontrakt.
- [ ] `oasdiff` jako alternatywny provider OpenAPI.
- [ ] Odczyt katalogu Backstage (`catalog-info.yaml`) jako źródło mapy.
- [ ] Kolejność i środowiska wdrożeń z pipeline'ów (Azure Pipelines, GitHub Actions, Helm, Argo CD).
- [ ] Źródło innych repo przez API hosta (GitHub/ADO przez MCP), bez klonu.
- [ ] Testy kontraktowe Pact i bramka „can-i-deploy”.
