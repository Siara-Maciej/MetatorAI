# ADR: decyzje architektoniczne MetatorAI

Statusy: `Proposed` → `Accepted` → `Superseded` / `Deprecated`. Agenci tworzą wyłącznie `Proposed`, akceptuje człowiek.

| ADR | Tytuł | Status |
|-----|-------|--------|
| [0001](0001-capabilities-and-providers.md) | Capabilities i providery | Accepted |
| [0002](0002-di-container.md) | Własny mały kontener DI z typowanymi tokenami | Superseded by 0011 |
| [0003](0003-interchange-formats.md) | Formaty wymiany: SARIF, JUnit XML, LCOV | Accepted |
| [0004](0004-configuration.md) | Konfiguracja: metator.config.ts / .json, warstwy, jeden schemat | Accepted |
| [0005](0005-canonical-agent-format.md) | Kanoniczny format agentów i generatory hostów | Accepted |
| [0006](0006-distribution.md) | Dystrybucja: npm, samodzielna binarka, obraz Docker | Accepted |
| [0007](0007-security-model.md) | Model bezpieczeństwa: allowlista komend i jawne pluginy | Accepted |
| [0008](0008-typescript-7-graph.md) | Graf importów przy TypeScript 7 (natywny kompilator) | Accepted, częściowo zastąpiony przez 0017 |
| 0009 | *zarezerwowany: platforma hostów (spike F0)* | – |
| [0010](0010-dependency-policy.md) | Polityka zależności: gotowe biblioteki zamiast własnych | Accepted |
| [0011](0011-di-awilix.md) | DI: awilix | Accepted |
| [0012](0012-graph-graphlib.md) | Graf zależności: @dagrejs/graphlib | Accepted |
| [0013](0013-state-machine-xstate.md) | Maszyna stanów runu: XState v5 | Accepted |
| [0014](0014-cli-commander.md) | Parser CLI: commander | Accepted |
| [0015](0015-schemas-zod-yaml.md) | Schematy i specyfikacje: zod + yaml | Accepted |
| [0016](0016-versioned-documents.md) | Każdy plik jest wersjonowanym dokumentem | Accepted |
| [0017](0017-imports-oxc.md) | Analiza importów JS/TS: oxc-parser + oxc-resolver | Accepted |
| [0018](0018-workspaces-manypkg.md) | Pakiety workspace: @manypkg/get-packages | Accepted |
| [0019](0019-git-simple-git.md) | Obsługa gita: simple-git | Accepted |
| [0020](0020-rule-canon.md) | Kanon reguł jako wersjonowany YAML, adaptery hostów i silniki E1 | Accepted |
| [0021](0021-memory-map.md) | Mapa pamięci jako wersjonowany dokument i strażnik CI | Accepted |
| [0022](0022-module-cards.md) | Karty modułów: generowany blok z grafu, sekcje kuratorowane | Accepted |
| [0023](0023-pattern-catalog.md) | Katalog wzorców z wykrywaniem w ast-grep i `similar` | Accepted |
| [0024](0024-adr-lint.md) | `adr lint`: łańcuch ADR → reguła i spójny dziennik decyzji | Accepted |
| [0025](0025-biome-engine-sarif.md) | Biome jako silnik E1 przez SARIF | Accepted |
| [0026](0026-memory-dupes.md) | Duplikaty wiedzy i macierz dostępu do pamięci | Accepted |
| [0027](0027-tsc-engine.md) | tsc jako silnik E1, włączone reguły narzędzi i wybór silników | Accepted |
| [0028](0028-discovery.md) | Discovery: package-manager-detector i shell-quote | Accepted |
| [0029](0029-config-gates.md) | `metator.config`, `init` i bramki `gate quick\|full` | Accepted |
| [0030](0030-canonical-agents.md) | Agenci kanoniczni i generatory hostów (Copilot, Claude Code) | Accepted |
| [0031](0031-findings.md) | Znaleziska review: schemat, polityka dowodów i walidacja cytatów | Accepted |
| [0032](0032-review-core.md) | Subflow review: plan shardów, werdykt i komentarze | Accepted |
| [0033](0033-review-evals.md) | Evale review: złoty zbiór, punktacja i bramka regresji | Accepted |
| [0034](0034-conformance-tests.md) | Testy zgodności jako silnik E1 i kanon w 100% egzekwowany narzędziami | Accepted |
| [0035](0035-plan-gate.md) | Bramka planu: `plan lint` i `plan scope` | Accepted |
| [0036](0036-graph-diff-test-affected.md) | `graph diff` i `test affected` | Accepted |
| [0037](0037-run-approvals.md) | Zgody w runie: `RunRecord` v2 i `run approve` | Accepted |
| [0038](0038-guard-hooks.md) | Hooki `guard *` i konfiguracja hooków hostów | Accepted |
| [0039](0039-skills-audit-check-all.md) | Skille kanoniczne, `meta skills-lint`, `meta audit` i `meta check-all` | Accepted |
| [0040](0040-symbols-api.md) | Symbole i API: `symbols find`, `graph callers`, `api snapshot\|diff` | Accepted |
| [0041](0041-gate-checks-coverage.md) | Kroki MetatorAI w bramkach, `MetatorConfig` v2 i `coverage diff` | Accepted |
| [0042](0042-workflow-anatomy.md) | `Workflow` v2 z anatomią i `workflow lint` | Accepted |
| [0043](0043-workers-skills-w1-w5.md) | Workerzy, skille i specyfikacje W1–W5 | Accepted |
| [0044](0044-run-close-lessons-quotes.md) | `run handoff\|close`, `lessons add`, `findings check-quote`, `debug-tags check` | Accepted |
| [0045](0045-owners-docs-checks.md) | `owners`, `docs inventory\|links\|drift`, właściciele i wzorce w kartach | Accepted |
| [0046](0046-autopilot-author-flow-t0.md) | Autopilot, Author/Reviewer flow i T0 ≤ 4000 znaków | Accepted |
| [0047](0047-system-map.md) | `SystemMap`: aplikacje, kontrakty i kolejność wdrożeń | Accepted |
| [0048](0048-user-docs-site.md) | Dokumentacja użytkownika jako strona VitePress na GitHub Pages | Accepted |
| [0049](0049-setup-install-canon.md) | `metator setup` i instalacja kanonu z pakietu (`InstallLock`) | Accepted |
| [0050](0050-run-worktrees.md) | Worktree runu i bloki portów (`WorktreeRegistry`, `RunRecord` v3) | Accepted |
| [0051](0051-cli-drives-runs.md) | CLI prowadzi run (`AgentHost`, `run drive`, `RunActivity`, `Question`) | Accepted |
| [0052](0052-interactive-run.md) | Interaktywny `metator run` i `run continue` | Accepted |
| [0053](0053-environments.md) | Środowisko aplikacji (`Environment`, `env *`) | Accepted |
| [0054](0054-terminal-sessions-ui.md) | `metator ui`, edytor w konfiguracji i port `Launcher` | Accepted |
| [0055](0055-fast-start.md) | Szybki start środowiska (`env analyze`, izolacja danych, pula, częściowy start) | Accepted |
| [0056](0056-independent-repositories.md) | Niezależne repozytoria na jednej maszynie | Accepted |
| [0057](0057-folder-of-repositories.md) | Folder repozytoriów (`metator.repos.yml`, `repos *`) | Accepted |
| [0058](0058-ask.md) | Pytania do kodu: `metator ask`, agent `mt-guide`, `Conversation` | Accepted |
| [0059](0059-work-overview.md) | Przegląd pracy: `metator status` (`WorkOverview`) | Accepted |
| [0060](0060-terminal-ui-ink.md) | Pełnoekranowy `metator ui` na Ink | Accepted |
| [0061](0061-package-architecture.md) | Architektura pakietów (`arch analyze`, `ArchitectureReport`, `ArchitecturePolicy`) | Accepted |
| [0062](0062-architecture-ratchet.md) | Architektura w CI: zapadka, baseline, SARIF i pierwsza polityka | Accepted |
| [0063](0063-architecture-metrics.md) | Metryki i granice pakietów, historia zmian, raport HTML | Accepted |
| [0064](0064-architecture-moves.md) | Ruchy refaktoru jako dane, symulacja i najtańsze cięcie cykli | Accepted |
| [0065](0065-refactor-plans.md) | Plany refaktoru (`RefactorPlan`, `mt-arch-planner`, wykonanie runami W3) | Accepted |
| [0066](0066-architecture-evals.md) | Ewaluacja planowania refaktoru (`ArchEvalCase`, `arch eval`, `Sandbox`) | Accepted |
| [0067](0067-system-discover.md) | `system discover`: topologia, aplikacje, kontrakty i konsumenci z dowodami | Accepted |
| [0068](0068-system-impact.md) | `system impact`: mapa przypięta w repozytorium platformy, źródła innych repozytoriów i zasięg zmiany | Accepted |
| [0069](0069-contract-diff.md) | `contract diff`: zmiana kontraktu oceniana różnicą specyfikacji i polityką mapy | Accepted |
| [0070](0070-system-plan.md) | Plan systemowy: `SystemAnalysis`, `SystemPlan`, lint kolejności i strategii, agenci systemowi | Accepted |
| [0071](0071-linked-runs.md) | Runy powiązane: run systemowy W13 i runy-dzieci w repozytoriach aplikacji | Accepted |
| [0072](0072-system-evals.md) | Złoty zbiór zmian systemowych i score analizy oraz planu | Accepted |
| [0073](0073-openapi-differ.md) | Differ OpenAPI na `api-smart-diff`: parametry, OpenAPI 3.1 i Swagger 2 przez konwersję | Proposed |
| [0074](0074-modules-inside-a-package.md) | Moduły wewnątrz pakietu: modularny monolit analizowany jak monorepo | Proposed |
