# ADR: decyzje architektoniczne MetatorAI

Statusy: `Proposed` → `Accepted` → `Superseded` / `Deprecated`. Agenci tworzą wyłącznie `Proposed`, akceptuje człowiek.

| ADR | Tytuł | Status |
|-----|-------|--------|
| [0001](0001-capabilities-and-providers.md) | Capabilities i providery | Proposed |
| [0002](0002-di-container.md) | Własny mały kontener DI z typowanymi tokenami | Superseded by 0011 |
| [0003](0003-interchange-formats.md) | Formaty wymiany: SARIF, JUnit XML, LCOV | Proposed |
| [0004](0004-configuration.md) | Konfiguracja: metator.config.ts / .json, warstwy, jeden schemat | Proposed |
| [0005](0005-canonical-agent-format.md) | Kanoniczny format agentów i generatory hostów | Proposed |
| [0006](0006-distribution.md) | Dystrybucja: npm, samodzielna binarka, obraz Docker | Proposed |
| [0007](0007-security-model.md) | Model bezpieczeństwa: allowlista komend i jawne pluginy | Proposed |
| [0008](0008-typescript-7-graph.md) | Graf importów przy TypeScript 7 (natywny kompilator) | Proposed, częściowo zastąpiony przez 0017 |
| 0009 | *zarezerwowany: platforma hostów (spike F0)* | – |
| [0010](0010-dependency-policy.md) | Polityka zależności: gotowe biblioteki zamiast własnych | Proposed |
| [0011](0011-di-awilix.md) | DI: awilix | Proposed |
| [0012](0012-graph-graphlib.md) | Graf zależności: @dagrejs/graphlib | Proposed |
| [0013](0013-state-machine-xstate.md) | Maszyna stanów runu: XState v5 | Proposed |
| [0014](0014-cli-commander.md) | Parser CLI: commander | Proposed |
| [0015](0015-schemas-zod-yaml.md) | Schematy i specyfikacje: zod + yaml | Proposed |
| [0016](0016-versioned-documents.md) | Każdy plik jest wersjonowanym dokumentem | Proposed |
| [0017](0017-imports-oxc.md) | Analiza importów JS/TS: oxc-parser + oxc-resolver | Proposed |
| [0018](0018-workspaces-manypkg.md) | Pakiety workspace: @manypkg/get-packages | Proposed |
| [0019](0019-git-simple-git.md) | Obsługa gita: simple-git | Proposed |
| [0020](0020-rule-canon.md) | Kanon reguł jako wersjonowany YAML, adaptery hostów i silniki E1 | Proposed |
| [0021](0021-memory-map.md) | Mapa pamięci jako wersjonowany dokument i strażnik CI | Proposed |
| [0022](0022-module-cards.md) | Karty modułów: generowany blok z grafu, sekcje kuratorowane | Proposed |
