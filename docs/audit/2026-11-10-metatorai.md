# Audyt F0 na MetatorAI (dogfood), 2026-11-10

Narzędzia z F0 uruchomione na tym repozytorium, bo repozytorium pilota jeszcze nie jest podpięte. Każda liczba pochodzi z komendy, którą można powtórzyć; sekcje odpowiadają punktom F0 w [ROADMAP](../ROADMAP.md).

## Inwentarz: agenci, skille, instrukcje, ADR (`metator meta audit`, `metator memory inventory`, `metator docs inventory`)

| Co | Ile | Skąd |
|---|---|---|
| agenci kanoniczni (`metator/agents/`) | 29 | `meta audit` (węzły `canonical`) |
| pliki hostów wygenerowane (`.github/agents`, `.claude/agents`) | 54 | `memory inventory` (`t1.host-agents`) |
| skille (`.github/skills`, `.claude/skills`) | 18 plików | `memory inventory` (`t1.host-skills`) |
| ADR | 82 | `memory inventory` (`t1.adr`) |
| pliki wiedzy ogółem | 393, ~421 tys. tokenów | `memory inventory` |
| dokumenty Markdown | 299, najstarszy 15 dni | `docs inventory` |

Warstwy pamięci: T0 (zawsze ładowane) 2 pliki w budżecie 4000 znaków; T1 388 plików ładowanych na żądanie; T4 (lekcje) 3 pliki. `metator memory check` i `memory budget` czyste.

## Graf wywołań agent → agent/skill (`metator meta audit`)

- Cykle: **0**. Zagnieżdżenia głębsze niż 2: **0**. Odwołania do nieistniejących agentów lub skilli: **0**.
- Elementy, do których żaden agent nie odsyła („martwe” z punktu widzenia grafu): `mt-arch-planner`, `mt-guide`, `mt-system-planner`, `mt-system-scout`. Każdy z nich jest punktem wejścia komendy (`arch plan propose`, `ask`, `system plan propose`), nie martwym kodem; adnotacja w karcie agenta wystarczy.

## Karta zgodności orchestratorów (`metator workflow lint`)

6 workflowów (`mt-feature`, `mt-bugfix`, `mt-refactor`, `mt-pr-review`, `mt-self-review`, `mt-system-change`), 16 sekcji każdy: **0 problemów**.

## Co zostaje na pilota

Te same trzy komendy na repozytorium pilota, raport w tym katalogu pod jego nazwą; różnice (cykle, zagnieżdżenia, orchestratory bez sekcji) stają się zadaniami F1 (rename na `mt-*`, spec YAML orchestratorów).
