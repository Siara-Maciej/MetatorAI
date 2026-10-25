# Dokumentacja MetatorAI

> Status: **pre-alpha**, projekt w fazie F1 (fundament). Dokumenty projektowe są po polsku, publiczne README po angielsku.

## Najpierw przeczytaj

| Dokument | O czym |
|----------|--------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architektura produktu: capabilities ↔ providers, warstwy (clean/hexagonal), porty, DI, pluginy, konfiguracja, discovery (`metator init`), generatory hostów i CI, SOLID/DRY, testy, bezpieczeństwo |
| [ROADMAP.md](ROADMAP.md) | Fazy F0–F6 z zadaniami i mierzalnymi kryteriami wyjścia |

## Projekt workflow

| Dokument | O czym |
|----------|--------|
| [design/01-principles.md](design/01-principles.md) | Prawa nadrzędne i zasady dla każdego elementu: instrukcje, reguły, ADR, wzorce, karty modułów, agenci, skille, prompty, hooki, komendy, artefakty, pamięć, bramki, MCP, evale, nazewnictwo |
| [design/02-workflows.md](design/02-workflows.md) | Anatomia workflow (16 sekcji), workflow jako maszyna stanów w YAML, katalog 12 workflowów, audyt istniejących orchestratorów |
| [design/03-memory-map.md](design/03-memory-map.md) | Mapa pamięci: poziomy T0–T5, plik `memory-map.yml`, budowa w 9 krokach, budżety kontekstu, macierz agent × pamięć |
| [design/04-commands.md](design/04-commands.md) | Katalog komend CLI `metator` (po co, wejście/wyjście, priorytet) i szkice implementacji pluginów |
| [design/05-templates.md](design/05-templates.md) | Szablony: agent, skill, reguła, ADR, wzorzec, karta modułu, schematy JSON, hooki, prompt, lekcja |
| [design/06-running.md](design/06-running.md) | Uruchamianie: tryb interaktywny (VS Code) i demo trybu auto (`metator run drive`) |
| [design/07-ci-engines.md](design/07-ci-engines.md) | Copilot i Claude Code jako silniki, CI, self-hosted runner w Dockerze |
| [design/00-research-v1.md](design/00-research-v1.md) | Archiwum: pierwotny research i plan v1 |

## Decyzje architektoniczne

[adr/](adr/), czyli rekordy decyzji projektu MetatorAI.

## Konwencje nazw w produkcie

| Element | Nazwa |
|---------|-------|
| Pakiet npm | `metator-ai` |
| CLI | `metator` (alias `mtr`), hooki: `metator-guard` |
| Konfiguracja projektu | `metator.config.ts` / `metator.config.json` |
| Artefakty lokalne | `.metator/` (index, runs, discovery) |
| Canon wiedzy projektu | `docs/metator/` (rules, patterns, modules, lessons, evals, memory-map.yml) |
| Spec workflow | `.github/metator/workflows/*.yml` |
| Prefiks agentów i skilli | `naming.agentPrefix`, domyślnie `mt-` |
| ID reguł projektu | `naming.rulePrefix`, domyślnie `MT-<AREA>-NNN` |
| Pakiety pluginów | `@metator/plugin-*` |
