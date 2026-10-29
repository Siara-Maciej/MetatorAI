# ADR-0066: Ewaluacja planowania refaktoru (`ArchEvalCase`, `arch eval`, `Sandbox`)

- Status: Accepted
- Data: 2026-10-29

## Kontekst
Jakość planów `mt-arch-planner` zależy od promptu i modelu. Bez pomiaru zmiana agenta to zgadywanie. Review ma złoty zbiór (ADR-0033), planowanie architektury go nie miało ([design/11 §6, H7](../design/11-package-architecture.md)).

## Decyzja
- **`ArchEvalCase` v1** (`docs/metator/evals/arch/<id>.yml`):
  - `goal`;
  - `files`, czyli całe małe monorepo inline, żeby źródła przypadków nie trafiały do grafu samego repozytorium;
  - `expect` z polami `fixed` (id naruszeń, które dobry plan naprawia), `forbidden` (id, które nie mogą zostać) i `maxMoves`.
  
  Dwa przypadki na start: cykl przez reguły w złym pakiecie i biblioteka importująca aplikację.
- **Port `Sandbox`** (`TempGitSandbox` w `plugin-bun`):
  - świeże repo git w katalogu tymczasowym z plikami przypadku, `.gitignore` i commitem;
  - `bun install --offline` linkuje workspace, więc importy po nazwie rozwiązują się do plików;
  - ścieżki spoza piaskownicy są odrzucane;
  - `dispose` usuwa katalog.
- **`arch eval run`:**
  - dla każdego przypadku: piaskownica z przypadkiem i zainstalowaną definicją `mt-arch-planner` (`.claude/agents`, `.github/agents` z tego repozytorium) oraz kontener CLI dla jej korzenia;
  - `arch plan propose` na hoście;
  - ocena jest deterministyczna: średnia pięciu sprawdzeń (lint czysty, cel osiągnięty, udział oczekiwanych napraw, brak zakazanych naruszeń, liczba ruchów w limicie);
  - przypadek, którego nie da się zaplanować, dostaje 0;
  - `--min` kończy się `CHECK_FAILED` poniżej progu.

## Konsekwencje
### Pozytywne
- Zmiana promptu albo modelu planisty jest mierzona tymi samymi narzędziami, którymi plan przechodzi w praktyce.
- e2e: oba dostarczone przypadki w prawdziwych piaskownicach. Dobry plan dostaje 1, plan, który tylko deklaruje, dostaje mniej, a `--min` kończy run błędem.
### Negatywne
- Przypadki z zależnościami spoza workspace wymagają sieci do instalacji. Bez niej zostają niezlinkowane, a ocena podziału i eksportów jest uboższa.
- Dwa przypadki to zalążek. Zbiór trzeba rozwijać z prawdziwych refaktorów, tak jak złoty zbiór review.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Fixture jako katalogi w repozytorium | ich importy i `package.json` mieszałyby się z grafem i workspace MetatorAI |
| Ocena planu przez model (LLM judge) | wynik musi być deterministyczny; lint, symulacja i oczekiwane id wystarczają |
| Rozszerzenie `EvalCase` z review | inne dane (pliki, cel) i inna miara; osobny dokument jest prostszy |

## Implikacje dla kodu
ADR-0066 egzekwują reguły kanonu MT-CODE-002, MT-TEST-003 (`metator rules show <id>`).
