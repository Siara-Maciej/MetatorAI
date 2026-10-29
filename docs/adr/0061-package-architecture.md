# ADR-0061: Architektura pakietów (`arch analyze`, `ArchitectureReport`, `ArchitecturePolicy`)

- Status: Proposed
- Data: 2026-10-29

## Kontekst
W dużym monorepo (np. 30 pakietów i 6 aplikacji) trzeba wiedzieć:
- czy pakiety tworzą cykle;
- czy `package.json` mówi prawdę o zależnościach;
- czy kierunki zależności zgadzają się z warstwami.

Bez tych faktów nie da się zaplanować refaktoru ([design/11](../design/11-package-architecture.md)). Metator ma graf importów plików (ADR-0012), ale dotąd tylko liczył krawędzie między pakietami (`graph packages`) i cykle plików (`graph cycles`).

## Decyzja
- **Graf pakietów z grafu plików.** `analyzeArchitecture` (czysta funkcja w domenie) agreguje rozwiązane importy plików w krawędzie pakiet → pakiet. Każda krawędź ma:
  - liczbę importów i importów w runtime (bez `import type`);
  - flagę „tylko z testów”;
  - pole `package.json`, które ją deklaruje;
  - do 5 przykładowych par plików.
  
  Plik należy do najgłębszego pakietu, który go zawiera, a pliki poza pakietami należą do `(root)`. Pakiet workspace importowany po nazwie bez instalacji (świeży klon) jest też krawędzią.
- **Rodzaj pakietu** (`app`, `lib`, `root`) według pierwszej pasującej reguły:
  1. reguła polityki;
  2. `projectType` z Nx;
  3. katalog `apps/`;
  4. pakiet, od którego coś zależy, to `lib`;
  5. `bin` albo skrypt `start|dev|serve` bez punktu wejścia to `app`.
- **Naruszenia** mają stabilne id (`rodzaj:przedmiot`), na którym opierają się baseline i wyjątki:
  - `cycle`: SCC grafu pakietów bez krawędzi z testów; cykl tylko przez `import type` domyślnie jest ostrzeżeniem;
  - `undeclared`, `root-only`, `dev-in-prod`, `unused-dependency`, `version-drift`: deklaracje w `package.json` kontra importy; skrypty i `@types/*` liczą się jako użycie;
  - `relative-import`: import ścieżką względną do innego pakietu;
  - `app-import`: zależność od aplikacji;
  - `layer`, `unlayered`, `tag`: polityka;
  - `expired-exception`, `unused-exception`: wyjątki;
  - `threshold`: metryki (H3).
- **Builtiny** (`fs`, `node:fs`, `bun:*`) nie są zależnościami. Analizator TypeScript zwraca teraz `fs` jako `node:fs`.
- **`ArchitecturePolicy` v1** (`metator/architecture.yml`, pisze człowiek):
  - `packages` (rodzaj, tagi i warstwa po nazwie albo katalogu);
  - `layers` (od góry; zależność w górę to błąd);
  - `rules`: `from` z tagami `allow`/`deny` zależności (jak `depConstraints` z Nx) albo `to` z tagami `allow`/`deny` zależnych (jak `dependents` w `boundaries` z Turborepo);
  - `tests`, `ignore`, `thresholds`, `severity` (dla każdego rodzaju `error`, `warning` albo `off`);
  - `exceptions` z powodem, właścicielem i datą wygaśnięcia; `*` w id oznacza dowolny tekst.
  
  Tagi pakietu łączą tagi polityki z tagami `project.json`, `package.json#nx` i `turbo.json`.
- **`ArchitectureReport` v1** (`.metator/arch/report.json` i `report.md`):
  - podsumowanie z wynikiem (100 − 5 × błędy − ostrzeżenia), pakiety, krawędzie, cykle, naruszenia i nierozwiązane importy;
  - sekcje `metrics`, `boundaries`, `coupling`, `teams` i `apps` są opcjonalne od v1, a wypełnia je H3.
- **Port `ManifestReader`.** Adapter `ManypkgManifestReader` w `plugin-node` czyta pakiety tam, gdzie `WorkspaceReader`, więc działa z każdym menedżerem znanym @manypkg.
- **Komendy:** `arch analyze`, `arch cycles`, `arch declared`, `arch schema`.

## Konsekwencje
### Pozytywne
- Fakty o architekturze są deterministyczne (E1) i sprawdzalne w CI. Pierwszy przebieg na samym MetatorAI znalazł rozjazd wersji `yaml` (poprawiony).
- Raport jest danymi: kolejne etapy (polityka w CI, metryki, symulacja ruchów, plan) czytają ten sam dokument.
- e2e na prawdziwym, niezainstalowanym monorepo: cykl `import type`, import aplikacji, import względny, niezadeklarowane i nieużywane zależności, warstwy, zła polityka.
### Negatywne
- Widać tylko to, co widzi analizator importów (TS/JS). Dynamiczne ścieżki i aliasy bundlera spoza `tsconfig` trafiają do sekcji nierozwiązanych.
- `unused-dependency` to tylko kandydat. Zależność używana w pliku konfiguracji, którego analizator nie czyta, będzie fałszywym alarmem, więc jest ostrzeżeniem.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| dependency-cruiser / madge jako silnik | drugi parser i drugi resolver obok oxc, którego używa cały graf; brak symulacji na tych samych danych |
| Osobny dokument `PackageGraph` | graf jest częścią raportu; drugi plik z tymi samymi danymi tylko by się rozjeżdżał |
| Reguły warstw tylko w ast-grep | reguła per import nie widzi pakietów, cykli ani `package.json` |
