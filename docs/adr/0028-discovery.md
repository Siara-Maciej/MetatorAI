# ADR-0028: Discovery: package-manager-detector i shell-quote

- Status: Proposed
- Data: 2026-10-26

## Kontekst
`metator init` i agent bootstrapu ([ARCHITECTURE §10](../ARCHITECTURE.md#10-discovery-i-bootstrap-agent-analizuje-codebase)) potrzebują faktów o repo z dowodami: jaki package manager, jakie workspace'y, które skrypty pełnią jaką rolę, jakie narzędzia, CI, code host i pliki AI. Uruchamianie skryptów projektu wymaga reguł przekazywania argumentów zależnych od package managera (npm wymaga `--`).

## Decyzja
- **`package-manager-detector`** (MIT, utrzymywany) w adapterze `NodePackageManager` (`plugin-node`), implementującym dwa małe porty:
  - `PackageManagerDetector`: pole `packageManager`, `devEngines`, lockfile'e; nigdy powyżej korzenia repo;
  - `PackageManager`: `resolveCommand(agent, "run", …)` buduje komendę uruchomienia skryptu; bez sygnału używany jest npm.
- **`shell-quote`** (czysty, bez I/O) dopuszczony w `@metator/core` (reguła `mt-arch-core-approved-deps`) do rozkładania skryptów złożonych (`&&`, `;`, `|`).
- **Klasyfikator skryptów** w domenie:
  - sygnały nazwy i komendy z §10.3; nazwa specyficzna (`test:e2e`) wygrywa z sygnałem komendy innej capability, nazwa ogólna (`check`, `ci`) nie;
  - `fileScopable` ocenia konserwatywnie: każdy argument pozycyjny po podkomendach narzędzia (`.`, `src`, glob) oznacza, że dopisane pliki nie zawężą przebiegu.
- **`metator discover`** zapisuje wersjonowany dokument `Discovery` (`.metator/discovery.json`): package manager z lockfile'ami (kilka to ostrzeżenie), workspace'y, skrypty z kandydatami, narzędzia (pliki konfiguracji i zależności), CI, code host z `git remote` (`Vcs.remoteUrl` na simple-git), katalog ADR, CODEOWNERS, pliki hostów AI.
- `package.json` jest czytany jako format package managera, nie jako dokument MetatorAI.

## Konsekwencje
### Pozytywne
- Fakty dla `metator init` i agenta bootstrapu bez zgadywania, każdy z dowodem `plik#pole`.
- Jedna ścieżka uruchamiania skryptów projektu dla bramek (`gate`).
### Negatywne
- Klasyfikator rozpoznaje popularne narzędzia JS/TS; inne języki wymagają nowych sygnałów.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Własna detekcja lockfile'i i reguł argumentów | duplikuje utrzymywaną bibliotekę (ADR-0010) |
| Podział skryptów po `&&` wyrażeniem regularnym | psuje cudzysłowy i escapowanie |
| `@pnpm/which-pm`, `preferred-pm` | pojedyncze narzędzia, bez budowania komend |
