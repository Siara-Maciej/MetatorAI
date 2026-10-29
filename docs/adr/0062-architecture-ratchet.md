# ADR-0062: Architektura w CI: zapadka, baseline, SARIF i pierwsza polityka

- Status: Proposed
- Data: 2026-10-29

## Kontekst
Duże monorepo ma dziś dziesiątki naruszeń architektury (ADR-0061). Bramka, która zatrzymuje każdy PR na wszystkich naruszeniach, zostanie wyłączona po tygodniu. Bramka, która niczego nie zatrzymuje, pozwala strukturze dalej się psuć. Polityki nie chcemy też pisać od zera, skoro Nx i Turborepo już mają reguły granic ([design/11 §5.6](../design/11-package-architecture.md)).

## Decyzja
- **Zapadka:** `arch check` zatrzymuje tylko naruszenia, które zmiana dodaje, czyli brakujące:
  - w raporcie na merge base (`--base`);
  - w baseline (`metator/arch-baseline.json`, `ArchitectureBaseline` v1: lista `{ id, kind }`);
  - pod aktywnym wyjątkiem polityki.
  
  Nowe błędy kończą się `CHECK_FAILED`, a nowe ostrzeżenia trafiają do `warnings`, chyba że podano `--strict`. Naruszenie pod wyjątkiem na bazie nie ukrywa tego samego naruszenia w zmianie, bo wyjątek wygasa.
- **Fakty na bazie:** liczone jak `graph diff` (ADR-0036). Bieżące fakty są łatane plikami zmienionymi od merge base: importy parsowane i rozwiązywane jak w bieżącym drzewie, `package.json` w wersji z bazy. Pliki i pakiety dodane na gałęzi na bazie nie istnieją. Polityka zawsze jest bieżąca.
- **Baseline:**
  - `arch baseline` przyjmuje stan obecny;
  - `arch baseline --tighten` tylko usuwa naprawione wpisy i nigdy nie dodaje nowych;
  - `arch check` wypisuje naprawione wpisy w `fixed`.
- **SARIF 2.1.0** (`--sarif <plik>`, ADR-0003):
  - jeden wynik na nowe naruszenie, w pierwszym pliku z dowodu;
  - `ruleId` to `arch/<rodzaj>`, a `partialFingerprints.metatorArchId` to id naruszenia, więc code scanning śledzi je między commitami.
- **Krok bramki** `{ metator: arch check }` dostaje `--base` bramki. Ten krok ma też bramka `full` samego MetatorAI.
- **`arch init`:**
  - proponuje `metator/architecture.yml` z tego, co jest: warstwę `apps` nad warstwą `libs` oraz reguły z `turbo.json#boundaries` (`dependencies` jako reguły `from`, `dependents` jako `to`) i z `depConstraints` Nx w `.eslintrc.json`/`.eslintrc` (także w `overrides`);
  - nigdy nie nadpisuje istniejącego pliku;
  - pliki JSONC czyta port `ToolBoundariesReader` (adapter `JsonToolBoundariesReader` na `Bun.JSONC`).
  
  Płaskich konfiguracji ESLint (`eslint.config.*`) nie czytamy, bo to kod.

## Konsekwencje
### Pozytywne
- Bramkę można włączyć w dużym repo od pierwszego dnia, a baseline maleje razem z naprawami.
- e2e: polityka z `turbo.json`, gałąź zamykająca cykl, która nie przechodzi `arch check --base main` i bramki (z SARIF), baseline i zacieśnienie po naprawie.
### Negatywne
- Id naruszenia zależy od nazw pakietów. Zmiana nazwy pakietu wygląda jak nowe naruszenie i trzeba wtedy odświeżyć baseline.
- Reguły Nx z konfiguracji w JS trzeba przepisać do polityki ręcznie.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Bramka na wszystkie naruszenia | w dużym repo zawsze czerwona, więc zostanie wyłączona |
| Tylko baseline bez porównania z bazą | każda gałąź musiałaby aktualizować baseline o naruszenia dodane w międzyczasie na main |
| Uruchamianie ESLint Nx jako silnika | wymaga Nx w repo; polityka MetatorAI działa w każdym workspace i obejmuje cykle oraz `package.json` |
