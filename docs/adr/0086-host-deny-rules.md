# ADR-0086: Nieodwracalne działania jako reguły deny hosta, nie tylko hook

- Status: Accepted
- Data: 2026-11-15

## Kontekst
Guard `pre-tool` (ADR-0038) odmawia czytania sekretów, komend niszczących pracę i scaleń (ADR-0085). Hook jest jednak procesem, który musi się uruchomić: gdy `metator` nie jest zainstalowany, gdy hook przekroczy limit czasu albo gdy sesja działa tam, gdzie ustawienia projektu nie obowiązują, odmowa nie pada. Claude Code ma własną warstwę reguł `permissions.deny`, czytaną przed hookami, przed pytaniem o zgodę i przed klasyfikatorem trybu auto; wywołanie pasujące do reguły deny nie trafia do żadnej z tych warstw.

Kryterium, co ma być twardą regułą: „jeśli agent pomyli się raz, czy da się to cofnąć?". Zły kod się cofa; sekret w transkrypcie, utracona niezacommitowana praca i scalenie do gałęzi głównej nie.

## Decyzja
- `metator generate --hooks` dopisuje do `.claude/settings.json` reguły `permissions.deny` obok konfiguracji hooków. Reguły użytkownika zostają pierwsze, nasze są dopisywane raz (generacja jest idempotentna).
- **Jedno źródło w domenie** (`packages/core/src/domain/hook.ts`): `SECRET_GLOBS` (już istnieje), `DENIED_COMMANDS` (początki komend: `gh pr merge`, `glab mr merge|accept`, `git push --force|-f|--force-with-lease`, `git reset --hard`, `git clean -f`) i `MERGE_MCP_TOOLS`. Generator hosta tylko tłumaczy je na składnię hosta.
- **Składnia Claude Code:** `Read(<nazwa>)` bez ukośnika dopasowuje plik na każdej głębokości; wyjątki (`.env.example`, `.env.sample`) to reguły `Read(!…)` po wzorcach, które zawężają; komenda występuje dwa razy, `Bash(<komenda>)` i `Bash(<komenda> *)`; narzędzia MCP jako `mcp__*__<narzędzie>`.
- **Hook pozostaje dokładnym sędzią.** Reguła prefiksowa nie wyrazi celu `git push` (gałąź `main`), `rm -r` katalogu głównego ani zgód runu; to dalej rozstrzyga `preToolPolicy`. Lista deny jest podzbiorem tego, czego hook i tak odmawia.
- Copilot nie ma odpowiednika `permissions.deny`; tam obowiązuje sam hook.

## Konsekwencje
### Pozytywne
- Dwie niezależne warstwy dla działań nieodwracalnych; awaria hooka nie otwiera drogi.
- Reguły działają także w trybie auto hosta, bez udziału klasyfikatora.

### Negatywne
- Dwie listy do utrzymania w zgodzie (prefiksy komend i funkcje `merge`/`destructive`); łagodzi to wspólny plik i testy obu.
- Reguły deny ograniczają też osobę pracującą w tej samej sesji hosta: `git reset --hard` trzeba wykonać poza agentem.
- Reguła `Read` nie zatrzyma procesu potomnego (np. zależności uruchomionej przez testy), który sam otworzy plik. To domyka dopiero sandbox (kolejny etap planu).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Tylko hook | pojedynczy punkt awarii dla działań, których nie da się cofnąć |
| Tylko reguły deny | nie wyrażą zgód runu, zakresu planu ani celu pusha |
| Osobny plik ustawień zarządzanych | wymaga uprawnień administratora maszyny; poza zakresem `generate` |

## Implikacje dla kodu
- Reguły kanonu, które to wiążą: listy żyją w domenie bez I/O (MT-ARCH-001), generator hosta w pluginie importuje je z `@metator/core` (MT-ARCH-005); `generate --hooks` ma e2e na prawdziwym procesie (MT-TEST-001), generator zabite mutanty (MT-TEST-003).
- `packages/core/src/domain/hook.ts`: `DENIED_COMMANDS`, `MERGE_MCP_TOOLS`.
- `packages/plugin-host-claude/src/claude-generator.ts`: `denyRules()` i scalanie z `permissions.deny` użytkownika.
- Dokumentacja użytkownika: `site/repo/hooks.md`, `site/reference/security.md`.
