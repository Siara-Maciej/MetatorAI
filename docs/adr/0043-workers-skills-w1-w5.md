# ADR-0043: Workerzy, skille i specyfikacje W1–W5

- Status: Accepted
- Data: 2026-10-26

## Kontekst
`workflow lint` (ADR-0042) wymaga, żeby każdy etap miał właściciela z kanonu. Orchestrator i review delegowały dotąd do kilku agentów (scout, pattern-miner, rule-curator, gatekeeper i soczewki review). Etapy planu, budowy, refactoru, diagnozy, dostarczenia i retrospektywy nie miały właścicieli, a W1–W5 istniały tylko jako opis w 02-workflows §3.

## Decyzja
- **Workerzy** w `metator/agents/`:
  - planowanie i budowa: `mt-planner`, `mt-plan-critic`, `mt-test-author`, `mt-implementer`, `mt-refactorer`;
  - dostarczenie i diagnoza: `mt-pr-author`, `mt-diagnostician`;
  - soczewka review: `mt-review-equivalence`;
  - wywoływani przez człowieka: `mt-docs-curator`, `mt-retro`.

  Każdy ma jedno zadanie, wąskie uprawnienia (komendy `metator`) i sekcję warunków stopu. `mt-orchestrator` deleguje według tabeli etapów; `mt-pr-review` dostaje soczewkę równoważności (`--lenses`).
- **Skille** w `metator/skills/`: `mt-create-from-pattern` (exemplar z indeksu wzorców zamiast szablonu na sztywno), `mt-characterization-tests` (z szablonem `references/equivalence.md`), `mt-review-rubric`, `mt-grill`, `mt-diagnose`.
- **W1–W5** (`mt-feature`, `mt-bugfix`, `mt-refactor`, `mt-pr-review`, `mt-self-review`) jako `Workflow` v2 w `.github/metator/workflows/`, z pełną anatomią. Maszyna stanów jest liniowa, więc W5 zaczyna od osobnego etapu `first-review`, a pętla naprawcza wraca z `review` do `plan`.
- `meta check-all` uruchamia `workflow lint`, więc każdy workflow w repo musi mieć pełną anatomię i właścicieli z kanonu.

## Konsekwencje
### Pozytywne
- Każdy etap W1–W5 ma właściciela, którego istnienie sprawdza CI.
- Hosty (Copilot, Claude Code) dostają agentów i skille z jednego kanonu (`metator generate`).
### Negatywne
- Jakość promptów workerów sprawdzą dopiero evale (W12) i zadania pilota.
- Etapy `optional` są tylko opisem: maszyna stanów ich nie pomija.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Jeden agent „builder” na plan, testy i implementację | brak niezależnego krytyka planu; testy pisane pod implementację |
| Szablony plików w skillach `mt-create-*` | rozjeżdżają się z kodem; indeks wzorców wskazuje żywy exemplar |

## Implikacje dla kodu
ADR-0043 egzekwują reguły kanonu MT-CODE-002, MT-TEST-001 (`metator rules show <id>`).
