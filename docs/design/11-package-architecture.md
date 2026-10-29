# Architektura pakietów dużego monorepo: graf, diagnoza i plan refaktoru (analiza i propozycja)

Status: **propozycja do decyzji użytkownika** (2026-10-29). Nic z tego nie jest jeszcze zaimplementowane.

## 1. Pomysł

Z rozmowy z użytkownikiem. Metator buduje już graf importów między plikami. Na tym samym grafie można zbudować **graf pakietów** dużego monorepo (np. 30 pakietów i 6 aplikacji) i odpowiedzieć na pytania:

1. Czy są **cykle** między pakietami, którędy dokładnie przechodzą i które krawędzie najtaniej przeciąć?
2. Czy podział odpowiedzialności ma sens? Który pakiet jest zbyt duży, zbyt cienki, zbyt mocno sprzężony albo jest zbędny?
3. **Jak zaplanować refaktor:** co, gdzie i w jakiej kolejności przenieść, żeby struktura miała sens. Ocena opiera się na grafie i na tym, po co każdy pakiet istnieje.

Wynikiem jest **plik**: raport architektury i plan refaktoru, który da się przejrzeć, zatwierdzić i wykonać.

## 2. Co już istnieje (fundament)

| Zdolność | Gdzie | Co daje dla tego pomysłu |
|----------|-------|--------------------------|
| Graf importów plików | `plugin-typescript` (`oxc-parser` + `oxc-resolver`: aliasy `tsconfig`, `exports`, symlinki workspace), cache `.metator/index/imports.json` | krawędzie plik → plik z rodzajem (`static`, `reexport`, `dynamic`) i flagą `typeOnly`; to surowiec, który wystarczy zagregować |
| Pakiety workspace | `plugin-node` (`@manypkg`: npm, yarn, pnpm, bun, lerna, rush) | lista pakietów z katalogami i `package.json` |
| `graph packages` | `GraphQueries.packageEdges()` | krawędzie pakiet → pakiet z liczbą importów (np. `@metator/cli → @metator/core: 47`) |
| `graph cycles`, `path`, `affected`, `dependents` | `DependencyGraph` na graphlib | cykle (SCC) **na poziomie plików**, najkrótsze ścieżki |
| `graph diff --base` | ADR o graph diff | nowe zależności pakietów i nowe cykle w zmianie (bramka „nie pogarszaj”) |
| Karty modułów | `cards build`, `docs/metator/modules/` | kuratorowane *Responsibility*, *Invariants*, *Allowed dependencies* |
| `owners`, `api snapshot/diff`, `similar`, `patterns`, `dupes` | F3/F6 | właściciel pakietu, publiczne API, duplikaty i wzorce |
| Reguły warstw | `rules/architecture/*.yml` (ast-grep), E1 | egzekwowanie warstw, ale ręcznie pisanymi regułami per repozytorium |
| `SystemMap` | F7.1 | poziom wyżej: aplikacje i kontrakty między nimi |
| Workflow refaktoru W3 | `mt-refactorer`, testy charakteryzujące, „bez nowych cykli” | wykonanie pojedynczego kroku refaktoru z dowodem |

Wniosek: **około 60% surowca jest gotowe.** Brakuje analizy na poziomie pakietów, polityki architektury jako dokumentu, symulacji ruchów i planu wykonywanego falami.

## 3. Luki

1. **Cykle pakietów.** `graph cycles` liczy SCC plików, a nie pakietów. Cykl `A → B → C → A` między pakietami może nie mieć cyklu plików, a nadal blokuje build, wersjonowanie i wydzielenie pakietu. Brakuje:
   - SCC grafu pakietów;
   - dla każdej krawędzi cyklu: które pliki i symbole ją tworzą;
   - propozycji minimalnego cięcia.
2. **Deklarowane a używane zależności.** Nikt nie porównuje `package.json` z importami. Ginie wtedy:
   - import pakietu nieobecnego w `dependencies` (działa przez hoisting, psuje się w CI);
   - zależność zadeklarowana, a nieużywana;
   - `devDependency` importowana w kodzie produkcyjnym.
3. **Polityka architektury.** Warstwy i dozwolone kierunki są dziś zapisane jako reguły ast-grep albo tylko w prozie kart. Brakuje deklaratywnego dokumentu, z którego wynikają i sprawdzenie, i raport (odpowiednik tagów `scope:`/`type:` z Nx).
4. **Metryki.**
   - Brakuje stabilności według Martina: `Ca`, `Ce`, `I = Ce / (Ca + Ce)`, abstrakcyjności `A` i odległości od głównej sekwencji `D`.
   - Brakuje też głębokości w DAG, fan-in i fan-out oraz rozmiaru.
5. **Spójność wewnątrz pakietu.**
   - Pakiet, którego pliki tworzą rozłączne skupiska z rozłącznymi konsumentami, to kandydat do **podziału**.
   - Pakiet używany przez jednego konsumenta to kandydat do **scalenia**.
6. **Ukryte sprzężenie z historii.** Pakiety zmieniane zawsze razem (git co-change) bez krawędzi w grafie to sygnał źle postawionej granicy.
7. **Granice zespołów.** Krawędzie między pakietami różnych właścicieli (CODEOWNERS) to koszt koordynacji, którego graf importów nie pokazuje.
8. **Symulacja.** Brakuje odpowiedzi na pytanie „co się stanie, jeśli przeniosę plik X z A do B” *bez* ruszania kodu: nowe cykle, naruszenia i metryki.
9. **Plan wykonywalny.** Brakuje dokumentu z ruchami ułożonymi w fale, które Metator wykonuje jako runy W3 z bramkami.

## 4. Za i przeciw

### Za
- **Unikalne połączenie.** Narzędzia grafowe (dependency-cruiser, madge, skott, Nx graph) pokazują graf i łamią reguły, ale nie mówią, *co zrobić*. Agenci bez grafu zgadują. Metator ma oba: deterministyczny dowód i agenta do oceny sensu.
- **Dowód zamiast opinii.** Każdy ruch w planie jest symulowany na grafie, a jego efekt (`cykle −2`, `naruszenia −5`, `D` pakietu `core` z 0,61 na 0,12) jest liczbą E1, nie zdaniem modelu.
- **Bezpieczne wykonanie.** Zaplanowany refaktor idzie przez istniejący W3: testy charakteryzujące, `api diff`, `graph diff` „bez nowych cykli” i HITL. Duże monorepo nie dostaje jednego gigantycznego PR-a.
- **Zapadka zamiast big bangu.** Baseline naruszeń plus bramka „tylko nowe naruszenia” (jak `graph diff`) pozwala włączyć to w dużym repo od dnia pierwszego, bez naprawiania wszystkiego naraz.
- **Mała skala obliczeń.** Dla 36 węzłów graf pakietów jest trywialny. Koszt leży w grafie plików, który już jest cache'owany (oxc parsuje dziesiątki tysięcy plików w sekundy).
- **Tani start.** Agregacja istniejących krawędzi, SCC i metryki to dni pracy, nie miesiące.

### Przeciw i ryzyka
- **„Sens istnienia pakietu” nie jest obliczalny.** Graf mówi *jak*, nie *po co*. Ocenę odpowiedzialności musi zrobić agent na podstawie kart i kodu. To E2/E3, czyli może się mylić. Łagodzenie: agent tylko proponuje, każda propozycja ma dowód i symulację, a człowiek zatwierdza (ADR-0016 i reguła HITL).
- **Minimalne cięcie cykli to problem NP-trudny** (feedback arc set). Na grafie pakietów (do ~100 węzłów) heurystyka Eadesa–Lina–Smytha z wagami krawędzi daje dobry wynik. Dla małych SCC można policzyć dokładnie. Raport mówi wprost, kiedy wynik jest heurystyczny.
- **Importy, których parser nie widzi:**
  - dynamiczne ścieżki (`import(\`./${x}\`)`), DI po nazwie, rejestry pluginów;
  - aliasy bundlera spoza `tsconfig` (webpack, vite).
  
  Łagodzenie: raport pokazuje „nierozwiązane importy” jako osobną sekcję, a polityka pozwala dopisać krawędzie ręcznie.
- **Tylko TypeScript i JavaScript.** Port `ImportAnalyzer` jest gotowy na inne języki, ale dziś jest jeden adapter. Monorepo poliglotyczne (np. Go i TS) dostaje analizę części TS. To ograniczenie, nie blokada.
- **Fałszywe alarmy metryk.** `D` Martina zakłada świat interfejsów i klas. W TS pakiet typów albo konfiguracji ma inne normy. Metryki muszą być **sygnałem z progami w polityce**, a nie wyrokiem.
- **Konkurencja z Nx i Turborepo.** Repo na Nx ma już `enforce-module-boundaries`. Metator nie może tworzyć drugiej, sprzecznej polityki. Łagodzenie: adapter czyta tagi Nx (`project.json`) jako źródło polityki.
- **Koszt dużych ruchów.** Przeniesienie pliku między pakietami zmienia ścieżki importów u wszystkich konsumentów. Bez narzędzia do przepisywania importów to ręczna praca. Łagodzenie: ruchy wykonuje W3 z codemodem (ast-grep `rewrite` albo ts-morph, jeśli ADR-0010 to uzasadni).

### Werdykt
**Wykonalne i warte zrobienia.** Część deterministyczna (graf pakietów, cykle, deklaracje, polityka, metryki, symulacja, zapadka) jest pewna i szybka do zrobienia. Część oceniająca (odpowiedzialności, plan) jest wartościowa tylko wtedy, gdy każda propozycja przechodzi przez symulację i człowieka. Bez tego byłaby zgadywaniem.

## 5. Proponowane rozwiązanie (wersja enterprise)

### 5.1 Trzy warstwy

```
Fakty (E1, deterministyczne)  →  Diagnoza (E1 + progi polityki)  →  Plan (agent E2/E3 + symulacja E1 + HITL)
graf plików, pakiety,            cykle, naruszenia, metryki,         ruchy z dowodem, fale, runy W3
package.json, git, CODEOWNERS    kandydaci split/merge, zapadka
```

### 5.2 Dokumenty (każdy wersjonowany, ADR-0016)

| Dokument | Plik | Kto pisze | Zawartość |
|----------|------|-----------|-----------|
| `ArchitecturePolicy` v1 | `metator/architecture.yml` (w repo, przegląd w PR) | człowiek, `arch init` proponuje | warstwy (`apps → features → domain → shared`); tagi (`scope:`, `type:`) przypisane globami albo z Nx; dozwolone kierunki; progi metryk; wyjątki z **właścicielem i datą wygaśnięcia** |
| `PackageGraph` v1 | `.metator/arch/graph.json` (generowany) | `arch analyze` | węzły: pakiet, rodzaj (`app`, `lib`, `tooling`), właściciel, rozmiar, tagi; krawędzie: waga (importy, symbole), `runtime` czy `typeOnly`, deklarowana czy nie, pliki źródłowe krawędzi |
| `ArchitectureReport` v1 | `.metator/arch/report.json` + render `report.md` / `report.html`, SARIF dla naruszeń | `arch analyze` | patrz 5.3 |
| `ArchitectureBaseline` v1 | `metator/arch-baseline.json` (w repo) | `arch baseline` | zaakceptowane dziś naruszenia; bramka liczy tylko nowe |
| `RefactorPlan` v1 | `metator/arch/plans/<id>.yml` (w repo) | agent `mt-arch-planner`, `arch plan lint` sprawdza | ruchy, ich dowody, symulowany efekt, fale, status każdego ruchu |

### 5.3 Zawartość raportu

1. **Podsumowanie.** Wynik zdrowia (ważona suma naruszeń), trend względem poprzedniego raportu i baseline'u, pięć najważniejszych problemów.
2. **Cykle pakietów.** Dla każdego SCC:
   - pakiety w cyklu;
   - każda krawędź z wagą oraz plikami i symbolami, które ją tworzą;
   - proponowane cięcie (najmniejsza suma wag);
   - typowe sposoby przecięcia: przeniesienie symbolu, wydzielenie wspólnego pakietu, odwrócenie zależności przez port.
   
   Cykle tylko z `import type` są w osobnej grupie, bo mają niższą wagę.
3. **Naruszenia polityki.** Kierunek wbrew warstwom, aplikacja importowana przez bibliotekę, import z wnętrza pakietu z pominięciem `exports`.
4. **Deklaracje.** Zależności niezadeklarowane, nieużywane, `devDependency` w kodzie produkcyjnym, rozjazd wersji tej samej zależności między pakietami.
5. **Metryki per pakiet.**
   - `Ca`, `Ce`, `I`, `A`, `D`, głębokość, rozmiar, procent publicznego API używanego z zewnątrz;
   - wykres `I`/`A` z „strefą bólu” i „strefą bezużyteczności”.
6. **Odpowiedzialność i granice:**
   - kandydaci do podziału: skupiska plików (Louvain na grafie wewnątrz pakietu) z rozłącznymi konsumentami;
   - kandydaci do scalenia: jeden konsument, mały rozmiar, wspólna zmiana;
   - pakiety „god” i „hub”;
   - martwe eksporty i martwe pakiety.
7. **Sprzężenie z historii.** Pary pakietów o wysokim współczynniku wspólnych zmian bez krawędzi albo wbrew kierunkowi.
8. **Zespoły.** Krawędzie między właścicielami, pakiety bez właściciela, właściciel z największą liczbą zależności przychodzących.
9. **Aplikacje.** Domknięcie zależności każdej z 6 aplikacji, wspólne jądro, pakiet, którego zmiana dotyka najwięcej aplikacji (promień rażenia).
10. **Nierozwiązane importy.** Czego parser nie umiał rozwiązać, czyli granica pewności raportu.

### 5.4 Symulacja ruchów (rdzeń wartości)

Ruch to dane, nie prosta zmiana kodu:
- `move { files, from, to }`;
- `extract { symbols, from, newPackage }`;
- `merge { from, into }`;
- `split { package, clusters }`;
- `invert { edge, port }` (interfejs w pakiecie niższym, implementacja w wyższym);
- `declare { package, dependency }`.

`arch simulate` stosuje ruch do `PackageGraph` w pamięci (plikowe krawędzie są przepisywane) i liczy różnicę raportu: cykle, naruszenia, metryki i liczbę plików do przepisania u konsumentów. Ruch, który nic nie poprawia albo psuje coś innego, nie wchodzi do planu. To E1: model proponuje, liczby rozstrzygają.

### 5.5 Plan i wykonanie

1. **`arch plan`** uruchamia agenta `mt-arch-planner`. Wejście to raport, karty modułów (*Responsibility*), polityka, `owners` i `similar`. Agent dla każdej propozycji pisze:
   - uzasadnienie odpowiedzialności z cytatami `plik:linia` i karty;
   - ruch jako dane;
   - wynik symulacji, który do planu wpisuje narzędzie, nie agent.
2. **`arch plan lint`** (E1) sprawdza, że:
   - każdy ruch ma dowód i symulację;
   - fale są w porządku topologicznym, bez ruchu zależnego od ruchu z późniejszej fali;
   - suma fal osiąga cel (np. zero cykli).
3. **HITL:** człowiek zatwierdza plan, w razie potrzeby ruch po ruchu.
4. **`arch plan run`** uruchamia każdą falę jako runy W3 (`mt-refactorer`). Każdy ruch to osobny run z testami charakteryzującymi, `api diff` i `graph diff`, a przepisanie importów robi codemod. Ruchy niezależne idą równolegle w osobnych worktree (F8.2).
5. Po każdym runie `arch analyze` aktualizuje stan ruchu w planie (`done`, `blocked` z powodem). Plan jest żywym dokumentem pokazywanym w `metator ui` i `metator status`.

### 5.6 Bramki CI i zapadka

- `arch check --base origin/main`:
  - nowy cykl pakietów, nowe naruszenie polityki, nowa niezadeklarowana zależność i przekroczony próg metryki ponad baseline → czerwono;
  - poprawa → podpowiedź `arch baseline --tighten`.
- SARIF z naruszeniami trafia do GitHub code scanning (adnotacje w PR).
- Nocny `arch analyze` (F5 `mt-nightly.yml`) zapisuje trend.
- Wygasły wyjątek w polityce to błąd z nazwą właściciela.

### 5.7 Komendy

```
metator arch init                       # proponuje ArchitecturePolicy z wykrytych warstw (lub z tagów Nx)
metator arch analyze [--format json|md|html|sarif] [--out <file>]
metator arch cycles | metrics | declared
metator arch check --base <ref>         # bramka: tylko nowe naruszenia
metator arch baseline [--tighten]
metator arch simulate --move <files> --to <pkg> | --merge <a> --into <b> | ...
metator arch plan [--goal no-cycles|layers|<custom>]   # agent + symulacja
metator arch plan lint | show | run [--wave N]
```

W folderze repozytoriów (G2) `arch analyze` daje raport każdego repozytorium osobno. Poziom między repozytoriami to `SystemMap` (patrz 5.9).

### 5.8 Architektura kodu (zgodnie z ADR i warstwami)

- `core/domain/package-graph.ts` zawiera czyste funkcje:
  - agregację, SCC, metryki i feedback arc set;
  - symulację ruchów i diff raportów.
- `core/domain/architecture-policy.ts` zawiera schemat oraz ocenę naruszeń.
- `core/application/architecture.ts` zawiera `AnalyzeArchitecture`, `CheckArchitecture`, `SimulateMove`, `PlanRefactor` i `RunRefactorPlan` (fale → `run init` W3 z rodzicem).
- **Nowe porty:**
  - `ManifestReader`: deklarowane zależności z `package.json`, adapter w `plugin-node`;
  - `ChangeHistory`: co-change z `git log --name-only`, adapter w `plugin-git`;
  - `ExportUsage`: używane i martwe eksporty.
  
  `ExportUsage` ma dwie opcje: adapter na **knip** (ADR-0010: gotowe narzędzie zamiast własnego) albo wykorzystanie `symbols` i istniejącego indeksu importów.
- **Gotowe pakiety (ADR-0010):**
  - `@dagrejs/graphlib` (jest) do SCC;
  - `graphology` + `graphology-communities-louvain` do skupisk;
  - knip do martwego kodu i deklaracji (ma reporter JSON);
  - render HTML: samowystarczalny plik z `cytoscape` (osadzonym) albo Mermaid dla małych grafów.
  
  Własny kod tylko tam, gdzie nie ma gotowca (symulacja, plan, polityka).
- Kontrakty portów w `packages/testing/src/contracts`, mutanty dla domeny, e2e na prawdziwym monorepo w temp (fixture z cyklem trzech pakietów, aplikacją importowaną przez bibliotekę i niezadeklarowaną zależnością).

### 5.9 Multi-repo i systemy

Ta sama metoda działa poziom wyżej. Węzłami są aplikacje i repozytoria z `SystemMap`, a krawędziami kontrakty (OpenAPI, eventy, wspólne pakiety npm z wersjami). To dokładnie otwarte F7.2–F7.5 (`system discover`, `SystemSourceReader`, `ContractDiffer`, `SystemAnalysis`/`SystemPlan`). Proponuję wspólny rdzeń: `PackageGraph` i `SystemGraph` korzystają z tych samych algorytmów (SCC, warstwy, symulacja, plan falami). Analiza pakietów jest pierwsza, bo daje wartość w jednym repozytorium i weryfikuje algorytmy na tańszym przypadku.

## 6. Etapy realizacji

| Etap | Zakres | Wartość od razu |
|------|--------|-----------------|
| **H1 Fakty** | `PackageGraph` v1, SCC pakietów z krawędziami i plikami, `ManifestReader` (deklarowane a używane), `arch analyze --format json|md`, `arch cycles`, `arch declared` | widać cykle pakietów i dziury w `package.json` |
| **H2 Polityka i zapadka** | `ArchitecturePolicy` v1 (warstwy, tagi, import z Nx), naruszenia, `ArchitectureBaseline` v1, `arch check --base`, SARIF, krok w `gate` | CI blokuje pogorszenie od pierwszego dnia |
| **H3 Metryki i granice** | Martin (`Ca`/`Ce`/`I`/`A`/`D`), głębokość, Louvain (split), merge, martwe eksporty (knip), `ChangeHistory`, zespoły, promień rażenia aplikacji, raport HTML | diagnoza „co jest nie tak z podziałem” |
| **H4 Symulacja** | ruchy jako dane, `arch simulate`, diff raportów, feedback arc set z propozycją cięcia | „co jeśli” bez ruszania kodu |
| **H5 Plan** | agent `mt-arch-planner`, `RefactorPlan` v1, `arch plan lint`, HITL, widok w `ui` i `status` | plan refaktoru z dowodem |
| **H6 Wykonanie** | `arch plan run` → fale runów W3 z codemodem importów, równolegle w worktree, aktualizacja stanu planu, runy powiązane (wspólne z F7.6) | refaktor monorepo wykonany i udowodniony |
| **H7 Ewaluacja** | złoty zbiór: monorepo z zasianymi cyklami i złymi granicami; trafność propozycji, odsetek ruchów odrzuconych przez symulację | mierzona jakość agenta |

H1 i H2 są w pełni deterministyczne, więc można je dostarczyć szybko i bez ryzyka. H5 i H6 zależą od jakości agenta, więc H7 jest warunkiem nazwania tego „enterprise”.

## 7. Audyt etapów (stan 2026-10-29)

| Faza | Stan | Co otwarte |
|------|------|------------|
| F1–F4, F6 (rdzeń: kanon, graf, reguły, agenci, workflowy, review) | zrobione | elementy ciągłe F6: retro po każdym runie, polityka Copilot Memory, kwartalny przegląd |
| F0 pilot | **otwarte** | inwentarz, karty zgodności orchestratorów, graf wywołań agentów, spike platformy (frontmatter, subagenci, hooki, skille, polityki org), baseline 3–5 zadań i 10 PR-ów; to wymaga repozytorium i organizacji pilota |
| F2 w pilocie | **otwarte** | rename istniejących agentów, spec YAML dla istniejących orchestratorów |
| W7, wzorce, złoty zbiór | **otwarte** | W7 na ADR pilota, wzorce do 10–15, złoty zbiór v1 (≥ 50 PR-ów); też zależne od pilota |
| F5 CI | **otwarte** | `mt-pr-review.yml`, `mt-nightly.yml`, `mt-eval.yml`, `copilot-setup-steps.yml`, lekkie instrukcje code review, telemetria; CI samego Metatora działa (lint, typecheck, testy, kanon, Pages) |
| F7.1 `SystemMap` | zrobione | — |
| **F7.2–F7.7 (wiele aplikacji i repozytoriów jako system)** | **otwarte** | `system discover`, `SystemSourceReader` i `system impact`, `ContractDiffer` i `contract diff`, `SystemAnalysis`/`SystemPlan` z agentami, runy powiązane W13, ewaluacje |
| F8.1–F8.7 (setup, worktree, drive, run, env, ui, szybkie środowiska) | zrobione | — |
| F8.8 dystrybucja npm | **zablokowane** | potrzebne konto npm właściciela; build i paczkę można przygotować wcześniej |
| G1–G5 (niezależne repozytoria, folder repozytoriów, `ask`, `status`, `ui` na Ink) | zrobione | G5: pełny przebieg mutantów przed wypchnięciem |

„Multi-repo” ma dwa znaczenia i stan jest różny:
- **wiele niezależnych repozytoriów na jednej maszynie i folder repozytoriów** jest zrobione (G1, G2, w tym widoki `ui`, `status` i `ask` w folderze);
- **wiele repozytoriów jako jeden system** (wpływ zmiany, kontrakty, plan i runy obejmujące repozytoria) jest otwarte (F7.2–F7.7). Proponowana analiza pakietów (H1–H7) dzieli z F7 rdzeń algorytmów, więc warto je zaplanować razem.

## 8. Decyzje do podjęcia przez użytkownika

1. Czy zaczynamy od H1+H2 (deterministyczne, szybka wartość), czy od razu planujemy całość H1–H7?
2. Czy analizę pakietów robimy przed F7.2–F7.7, czy razem, ze wspólnym rdzeniem grafu systemu?
3. Czy repozytoria docelowe używają Nx albo Turborepo (import tagów) i czy są poliglotyczne (potrzebny drugi `ImportAnalyzer`)?
4. Martwy kod i deklaracje: adapter na knip (nowa zależność, ADR) czy własna analiza na istniejącym indeksie?
