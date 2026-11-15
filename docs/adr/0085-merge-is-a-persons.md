# ADR-0085: Scalenie do gałęzi głównej należy do człowieka; agent co najwyżej otwiera MR/PR

- Status: Proposed
- Data: 2026-11-15

## Kontekst
Decyzja właściciela z 2026-11-15: scalenie do gałęzi głównej (head) nigdy nie może nastąpić z ręki agenta ani automatu MetatorAI. Najdalej idąca autonomia to samodzielne utworzenie merge requestu (GitLab) lub pull requestu (GitHub).

Do tej pory guard `pre-tool` traktował `gh pr merge` i narzędzie MCP `merge_pull_request` jak zwykły push: po `metator run approve push` (albo po zatwierdzeniu etapu `delivery`, który nadaje `push`) agent mógł scalić request. Scalenie jest nieodwracalne dla innych (trafia do wspólnej historii, uruchamia wdrożenia), więc zgodnie z zasadą „jeśli pomyłka nie daje się cofnąć, to musi być reguła w harnessie, a nie zdanie w prompcie" nie może zależeć od zgody na co innego ani od poziomu autonomii.

## Decyzja
- **Odmowa bezwarunkowa.** `preToolPolicy` odmawia scalenia zawsze: z runem i bez, przy każdej zgodzie i na każdym poziomie autonomii. Sprawdzenie stoi przed regułą zgód.
- **Co jest scaleniem:** `gh pr merge` (także `--auto`), `glab mr merge` i `glab mr accept`, wywołanie `gh api` / `glab api` na `/pulls/<n>/merge` lub `/merge_requests/<n>/merge`, narzędzia MCP `merge_pull_request`, `merge_merge_request`, `accept_merge_request`, `enable_pr_auto_merge`, `enable_auto_merge`, oraz `git push`, którego celem jest gałąź z `HEAD_BRANCHES` (`main`, `master`), także jako `src:dst`, `+dst` i `refs/heads/dst`.
- **Co zostaje pod zgodą `push`:** push gałęzi runu, `gh pr create`, `glab mr create`, narzędzia MCP tworzące gałąź, pliki lub request.
- **Jedno źródło.** Rozpoznanie żyje w `mergeAttempt` (`packages/core/src/domain/hook.ts`); host Claude w procesie (`ClaudeAgentHost`) woła tę samą funkcję, bo tam hook projektu może nie działać.
- **Porty code hosta nie dostają operacji scalenia.** `ReviewHost` i `CodeHost` czytają, odpowiadają i (po zgodzie) tworzą; metoda „merge” nie powstaje.
- **Klasa ryzyka zmiany steruje recenzją, nie scaleniem** (plan autonomii L2): niska klasa pozwala otworzyć MR/PR bez pytania, nigdy go scalić.

## Konsekwencje
### Pozytywne
- Gwarancja nie zależy od promptu, od zgody nadanej w innym celu ani od klasyfikatora hosta.
- Jedna funkcja i jej testy (unit, e2e na prawdziwym procesie hooka, mutanty) opisują całą regułę.

### Negatywne
- `git push` bez nazwy gałęzi, wykonany na checkoutcie gałęzi głównej, nie jest rozpoznawany: guard nie zna bieżącej gałęzi. Domyka to ochrona gałęzi w code hoście (wymagana recenzja, zakaz bezpośredniego pusha), którą ustawia właściciel repozytorium, oraz warunek `branch-ok` workflow.
- Repozytorium z inną nazwą gałęzi głównej niż `main`/`master` wymaga rozszerzenia `HEAD_BRANCHES` (kandydat na opcję w `MetatorConfig`).
- Osoba, która chce, żeby agent scalił request za nią, musi zrobić to sama.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Osobna zgoda `merge` | zgoda bywa nadawana hurtem (autopilot, `grants`), a decyzja właściciela brzmi „nigdy" |
| Zakaz tylko w promptach agentów | prompt nie jest gwarancją |
| Merge-when-ready dla zmian niskiego ryzyka | wykluczone decyzją właściciela |

## Implikacje dla kodu
- `packages/core/src/domain/hook.ts`: `HEAD_BRANCHES`, `mergeAttempt`, `MERGE_IS_A_PERSONS`, kolejność w `preToolPolicy`.
- `packages/plugin-host-claude/src/claude-agent-host.ts`: ta sama odmowa w hooku w procesie.
- Dokumentacja użytkownika: `site/repo/hooks.md`, `site/reference/hooks.md`, `site/reference/security.md`.
