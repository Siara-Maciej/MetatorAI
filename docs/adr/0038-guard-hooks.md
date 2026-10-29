# ADR-0038: Hooki `guard *` i konfiguracja hooków hostów

- Status: Accepted
- Data: 2026-10-26

## Kontekst
Bramki runu działały tylko wtedy, gdy agent sam wywołał `metator`. Model mógł edytować pliki spoza planu, pushować bez zgody, czytać sekrety albo zakończyć sesję w połowie etapu. Hooki hostów (Claude Code, VS Code Copilot) uruchamiają komendę przy każdym zdarzeniu i przyjmują jej decyzję. Format stdin/stdout jest wspólny (`tool_name`, `tool_input`, `hookSpecificOutput`); spike F0 (ADR-0009) ma go jeszcze potwierdzić na wersji organizacji.

## Decyzja
- **Komendy `guard <zdarzenie>`** czytają payload z stdin i odpowiadają w protokole hooka, a nie w kopercie (`Outcome.hook`, wyjątek od MT-CODE-004). Kod wyjścia to zawsze 0. Własny błąd guarda trafia do `systemMessage`, bez decyzji; wtedy decydują zwykłe reguły hosta.
- **`pre-tool`** (PreToolUse), polityka w domenie (`preToolPolicy`):
  - zawsze blokuje: sekrety (`.env*` bez `.env.example`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`) według ścieżki i argumentów komendy; komendy destrukcyjne (`git push --force`, `git reset --hard`, `git clean -f`, `rm -r` korzenia albo całego drzewa);
  - poza runem: tryb swobodny, reszta przechodzi;
  - w aktywnym runie: push i PR (shell, `gh`, narzędzia MCP) wymagają `approvals.push`, komentarze i review wymagają `approvals.comment` (ADR-0037);
  - edycje tylko w `plan-scope.json#edit` i w repo; `.metator/` jest zawsze zapisywalne;
  - koordynator nie edytuje. Rola pochodzi z agentów kanonicznych (`agent_type` w payloadzie) albo z `METATOR_ROLE`.
- **`post-edit`** (PostToolUse) uruchamia `rules check` na edytowanych plikach, tylko silnikami plikowymi (ast-grep, Biome). Naruszenia wracają jako kontekst; typecheck i testy zgodności zostają w bramkach.
- **`stop`** (Stop) blokuje zakończenie, gdy aktywny run stoi na etapie roboczym; czekanie na człowieka (etap HITL) jest dozwolone. Przy `stop_hook_active` niczego nie blokuje, więc nie powstaje pętla.
- **`subagent-output`** (SubagentStop): każdy plik JSON w katalogu runu musi być znanym, poprawnym dokumentem (FindingSet, Plan, PlanScope, Verdict, GateReport, ReviewPlan, EvalReport, RunRecord, RunPointer).
- **`session-start`** podaje aktywny run i brakujący indeks. **`precompact`** = `run checkpoint`, czyli streszczenie stanu w `log.md`.
- **`generate --hooks`** (opt-in) zapisuje konfigurację hooków: Claude Code w `.claude/settings.json#hooks` (inne ustawienia i własne hooki użytkownika zostają, wcześniejsze hooki MetatorAI są zastępowane), Copilot w `.github/hooks/metator.json`. Instalacja hooków zmienia to, co host uruchamia, więc wymaga jawnej decyzji.

## Konsekwencje
### Pozytywne
- Zakres planu, zgody i ochrona sekretów działają niezależnie od posłuszeństwa modelu.
- Polityka jest czystą funkcją z testami; format hosta jest w jednym module (`domain/hook.ts`).
### Negatywne
- Rola z payloadu zależy od hosta (`agent_type` nie zawsze jest podawany); bez niej reguła koordynatora wymaga `METATOR_ROLE`.
- `post-edit` dodaje ok. 1–2 s do każdej edycji.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Decyzja kodem wyjścia 2 | zachowanie różni się między hostami (spike F0); JSON jest jednoznaczny |
| Hooki zawsze generowane przez `generate` | instalowałyby się bez zgody użytkownika, także w `generate --check` |
| Odmowa przy błędzie guarda | uszkodzony `state.json` zablokowałby każde narzędzie, łącznie z jego naprawą |

## Implikacje dla kodu
ADR-0038 egzekwują reguły kanonu MT-ARCH-001, MT-CODE-004 (`metator rules show <id>`).
