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
| [0023](0023-pattern-catalog.md) | Katalog wzorców z wykrywaniem w ast-grep i `similar` | Proposed |
| [0024](0024-adr-lint.md) | `adr lint`: łańcuch ADR → reguła i spójny dziennik decyzji | Proposed |
| [0025](0025-biome-engine-sarif.md) | Biome jako silnik E1 przez SARIF | Proposed |
| [0026](0026-memory-dupes.md) | Duplikaty wiedzy i macierz dostępu do pamięci | Proposed |
| [0027](0027-tsc-engine.md) | tsc jako silnik E1, włączone reguły narzędzi i wybór silników | Proposed |
| [0028](0028-discovery.md) | Discovery: package-manager-detector i shell-quote | Proposed |
| [0029](0029-config-gates.md) | `metator.config`, `init` i bramki `gate quick\|full` | Proposed |
| [0030](0030-canonical-agents.md) | Agenci kanoniczni i generatory hostów (Copilot, Claude Code) | Proposed |
| [0031](0031-findings.md) | Znaleziska review: schemat, polityka dowodów i walidacja cytatów | Proposed |
| [0032](0032-review-core.md) | Subflow review: plan shardów, werdykt i komentarze | Proposed |
| [0033](0033-review-evals.md) | Evale review: złoty zbiór, punktacja i bramka regresji | Proposed |
| [0034](0034-conformance-tests.md) | Testy zgodności jako silnik E1 i kanon w 100% egzekwowany narzędziami | Proposed |
| [0035](0035-plan-gate.md) | Bramka planu: `plan lint` i `plan scope` | Proposed |
| [0036](0036-graph-diff-test-affected.md) | `graph diff` i `test affected` | Proposed |
| [0037](0037-run-approvals.md) | Zgody w runie: `RunRecord` v2 i `run approve` | Proposed |
| [0038](0038-guard-hooks.md) | Hooki `guard *` i konfiguracja hooków hostów | Proposed |
| [0039](0039-skills-audit-check-all.md) | Skille kanoniczne, `meta skills-lint`, `meta audit` i `meta check-all` | Proposed |
| [0040](0040-symbols-api.md) | Symbole i API: `symbols find`, `graph callers`, `api snapshot\|diff` | Proposed |
| [0041](0041-gate-checks-coverage.md) | Kroki MetatorAI w bramkach, `MetatorConfig` v2 i `coverage diff` | Proposed |
| [0042](0042-workflow-anatomy.md) | `Workflow` v2 z anatomią i `workflow lint` | Proposed |
| [0043](0043-workers-skills-w1-w5.md) | Workerzy, skille i specyfikacje W1–W5 | Proposed |
| [0044](0044-run-close-lessons-quotes.md) | `run handoff\|close`, `lessons add`, `findings check-quote`, `debug-tags check` | Proposed |
| [0045](0045-owners-docs-checks.md) | `owners`, `docs inventory\|links\|drift`, właściciele i wzorce w kartach | Proposed |
| [0046](0046-autopilot-author-flow-t0.md) | Autopilot, Author/Reviewer flow i T0 ≤ 4000 znaków | Proposed |
| [0047](0047-system-map.md) | `SystemMap`: aplikacje, kontrakty i kolejność wdrożeń | Proposed |
| [0048](0048-user-docs-site.md) | Dokumentacja użytkownika jako strona VitePress na GitHub Pages | Proposed |
| [0049](0049-setup-install-canon.md) | `metator setup` i instalacja kanonu z pakietu (`InstallLock`) | Proposed |
| [0050](0050-run-worktrees.md) | Worktree runu i bloki portów (`WorktreeRegistry`, `RunRecord` v3) | Proposed |
| [0051](0051-cli-drives-runs.md) | CLI prowadzi run (`AgentHost`, `run drive`, `RunActivity`, `Question`) | Proposed |
| [0052](0052-interactive-run.md) | Interaktywny `metator run` i `run continue` | Proposed |
| [0053](0053-environments.md) | Środowisko aplikacji (`Environment`, `env *`) | Proposed |
| [0054](0054-terminal-sessions-ui.md) | `metator ui`, edytor w konfiguracji i port `Launcher` | Proposed |
| [0055](0055-fast-start.md) | Szybki start środowiska (`env analyze`, izolacja danych, pula, częściowy start) | Proposed |
| [0056](0056-independent-repositories.md) | Niezależne repozytoria na jednej maszynie | Proposed |
| [0057](0057-folder-of-repositories.md) | Folder repozytoriów (`metator.repos.yml`, `repos *`) | Proposed |
