# 14. Wejście przez CLI agenta, automat zadań i odpowiedź na review

Status: **zaakceptowany** (właściciel, 2026-11-10; decyzje spisane w §0). ADR: [0083](../adr/0083-agent-cli-entry-and-event-intake.md). Wzorzec: herdr (terminal jest pierwszy, konfiguracja plikiem), przeniesiony na model MetatorAI: workflow jest prawem, agent decyduje w jego granicach, osoba dostaje decyzje w inboxie.

## 0. Decyzje właściciela (grill, 2026-11-10)

| # | Pytanie | Decyzja |
|---|---|---|
| 1 | Host kodu | oba (GitHub i GitLab) przez wspólny port, adaptery przez MCP; odpytywanie co 120 s |
| 2 | Autonomia przy review | analiza + plan + odpowiedzi na pytania automatycznie; zmiana kodu po „Napraw” |
| 3 | Autonomia przy issue | automat tworzy issue i sesję, pierwsza bramka workflow pyta osobę; pełna autonomia tylko regułą |
| 4 | Jedno wejście czy dwa workery | jedno: `metator intake` z regułami per źródło |
| 5 | Gdzie reguły | `metator.config.yml` per repo + `metator.repos.yml` dla listy repozytoriów |
| 6 | Sesja z review | worktree na gałęzi MR |
| 7 | „+ New session” | otwiera pane Copilot CLI z orkiestratorem w trybie intake; rozmowa może być tylko pytaniem o repo; agent ma MCP skonfigurowane w MetatorAI |
| 8 | Najpierw dokumenty | tak: ten projekt, ADR-0083, faza T |

## 1. Czego nie zmieniamy

- Sesja powstaje przez `POST /runs` demona (D3). Formularz „New session” i `metator issue start` już to wołają; wejścia z tego dokumentu wołają to samo.
- Dyrygent (`mt-orchestrator`) w PTY hosta (R2), bramki HITL i karta decyzji (P4/D5), polityki odpowiedzi (P5), supervisor (D4), worktree per run (F8.2), konflikty między worktree (P7), Issue v1 za zgodą (S4), ekran Review dla notatek *do* agenta (S5), telemetria reakcji (F5).
- Zasada herdr z design/13: workbench pokazuje agenta jak w konsoli, nic więcej na ekranie.

## 2. Wejście A: rozmowa w CLI agenta

### Cel
Osoba otwiera pane Copilot CLI i rozmawia: „jak działa X?”, „sprawdź, czy Y jest bezpieczne”, „napraw Z”. Agent odpowiada z cytatami `plik:linia`; sesję (run) zakłada tylko wtedy, gdy z rozmowy wynika zadanie. Formularz znika z pierwszego planu.

### Jak
- **Tryb intake w `mt-orchestrator`** (nowa sekcja w `metator/agents/mt-orchestrator.md`): bez runu odpowiada jak `mt-guide` (tylko czytanie, `metator ask`, `graph`, `symbols`, karty). Gdy osoba prosi o zmianę, agent: 1) sprawdza, czy kod już to robi (jak `mt-grill` krok 1); 2) dopytuje jednym komunikatem o to, czego repo nie powie (workflow, autonomia, worktree, repozytorium w folderze), z rekomendacją; 3) woła `metator run init --workflow … --task … [--worktree]` i `metator run drive` w tym samym pane, który staje się pane'em dyrygenta (demon przyjmuje istniejący pane jako `conductor`, R2: `run attach <pane>`).
- **„+ New session”** w aplikacji otwiera pane w bieżącym workspace z komendą hosta (`hostOrder`), z `mt-orchestrator` wczytanym przez `--agent`; formularz zostaje pod przyciskiem „zaawansowane” i jako edytor reguł (§3).
- **MCP agenta**: sekcja `mcp:` w `MetatorConfig` (repo) i `UserOptions` (osoba): nazwa, komenda lub URL, zmienne środowiskowe przez nazwę (wartości poza repo). `metator generate` wpisuje ją do konfiguracji hosta (Copilot CLI: `~/.copilot/mcp-config.json` scalone per repo; Claude Code: `.mcp.json`); `metator doctor` sprawdza, że serwery startują. Ten sam zestaw MCP dostaje automat z §3.

### Dane
Nic nowego poza `mcp:` w konfiguracji (nowa wersja `MetatorConfig` z migracją) i `UserOptions` v2. `Conversation` v1 (G3) zapisuje rozmowę bez runu; po `run init` run dostaje w `task.md` sekcję „Decisions” z odpowiedziami osoby.

## 3. Wejście B: automat zadań (`metator intake`)

### Cel
Zgłoszenie w GitHub Issues, GitLab Issues albo Jira staje się issue w backlogu i sesją bez udziału osoby; osoba widzi sesję jak każdą inną i dostaje pierwszą bramkę w inboxie. Przy regule z pełną autonomią automat dochodzi do PR.

### Reguły (`metator.config.yml`)
```yaml
intake:
  everyMs: 120000
  rules:
    - id: github-bugs
      source: { kind: github, repo: acme/shop, labels: [bug], state: open }
      workflow: mt-bugfix
      autonomy: gated          # gated | full
      worktree: true
    - id: jira-tasks
      source: { kind: jira, project: SHOP, type: Task, mcp: jira }
      workflow: mt-feature
      autonomy: gated
```
W folderze repozytoriów (`metator.repos.yml`) każda reguła mówi też `repo:`; demon folderu skanuje wszystkie.

### Przebieg jednego skanu
1. `CodeHost.listItems(rule.source)` przez MCP hosta (GitHub, GitLab, Jira). Treść zgłoszenia to **dane**: trafia do `task.md` jako cytat ze źródłem, nigdy do promptu systemowego.
2. Klucz źródła (`github:acme/shop#12`): jeśli Issue z tym kluczem istnieje, nic; inaczej `issue add --source …` (automat ma prawo dodawać tylko z reguły; bez reguły to `issue propose`).
3. `issue start` → `POST /runs` z workflow i autonomią reguły; `autonomy: full` ustawia `--choice autopilot` z bramkami `skipAt` workflow, ale push/PR zostaje bramką, chyba że reguła mówi `push: auto`.
4. Przed startem: `conflicts` (P7) na plikach, których dotyczy zgłoszenie, jeśli da się je wyczytać; przy konflikcie sesja czeka w inboxie z kartą „start mimo to / później”.
5. Wpis w aktywności runu `origin: intake`, w Issue `source` i `rule`.

### Granice
- Budżet: limit równoległych sesji automatu per repo (`intake.maxActive`, domyślnie 2) i limit kosztu na zadanie z telemetrii (P6); przekroczenie to pytanie w inboxie, nie cicha kontynuacja.
- Tożsamość: wpisy `by: intake`; tokeny do hostów w środowisku demona, nie w repozytorium.
- Nic nie jest usuwane ani zamykane po stronie źródła bez osoby.

## 4. Review mojego MR → analiza i plan (`mt-review-response`)

### Cel
Gdy ktoś zrecenzuje mój MR, aplikacja pokazuje to w zakładce **Open MRs**, agent od razu zbiera wątki, odpowiada na pytania, które wynikają z diffu, i przygotowuje plan poprawek; zmianę kodu robi po moim „Napraw”.

### Dane
- Port **`CodeHost`**: `listMyPullRequests()`, `reviewThreads(pr)`, `checks(pr)`, `reply(thread, text)`, `resolve(thread)`. Adaptery przez MCP (GitHub, GitLab); kontrakt w `packages/testing/src/contracts`.
- **`ReviewThread` v1** (`.metator/reviews/<host>/<pr>/threads.jsonl`): `id`, `pr`, `author`, `file`, `line`, `body` (cytat), `kind` (question | change | nit | praise, nadany przez agenta i poprawialny), `state` (open | answered | planned | fixed | resolved), `runId`, `sourceKey`.
- **Plan** w formacie `plan.json` runu (F4), każdy krok z cytatem wątku; ekran Plan (S2) pokazuje go bez zmian.

### Workflow `mt-review-response`
| Etap | Właściciel | HITL | Co robi |
|---|---|---|---|
| collect | demon | nie | wątki nowe od ostatniego skanu → `ReviewThread`, worktree na gałęzi MR |
| triage | `mt-review-responder` (nowy agent, czyta) | nie | `kind` per wątek; odpowiedzi na pytania z diffu i kart (`metator ask`), zapisane jako propozycje |
| plan | `mt-planner` | nie | `plan.json` dla wątków `change` i `nit`; `nothing to do` dla wątków już nieaktualnych |
| approve | osoba | **tak** | karta decyzji: plan, odpowiedzi do wysłania, koszt; „Napraw” / „Tylko odpowiedz” / „Pomiń” |
| build | `mt-implementer` | nie | zmiany w worktree gałęzi MR, testy, bramki repo |
| deliver | `mt-pr-author` | bramka push jak dziś | commit, push na gałąź MR, odpowiedzi w wątkach, `resolve` tych, które plan zamknął |

Polityka odpowiedzi (P5) może zdjąć bramkę `approve` dla wybranych recenzentów lub rodzajów (`nit` od bota lint), zgodnie z decyzją 2.

### Zakładka **Open MRs** (`#/mrs`)
Lista moich PR/MR ze wszystkich repozytoriów folderu: tytuł, gałąź, CI, liczba otwartych wątków, stan odpowiedzi agenta (czeka / plan gotowy / naprawione), ostatnia recenzja. Kliknięcie: wątki po lewej z `kind` i propozycją odpowiedzi, plan po prawej, przyciski „Napraw”, „Tylko odpowiedz”, „Otwórz sesję”. Powiadomienie systemowe na nową recenzję przez istniejące `notify`.

### Bezpieczeństwo
Treść wątku to tekst obcej osoby: trafia do agenta jako cytat w `task.md`, hooki blokują komendy spoza allowlisty jak w każdym runie, a zmiana kodu wymaga decyzji osoby (lub jawnej polityki). Agent nigdy nie zamyka MR, nie mergeuje i nie usuwa gałęzi.

## 5. Architektura w kodzie

| Warstwa | Co dochodzi |
|---|---|
| `core/domain` | `IntakeRule` w `MetatorConfig` (nowa wersja), `mcp:` w konfiguracji i `UserOptions` v2, `ReviewThread` v1, `Issue` v2 (`source`, `rule`), workflow `mt-review-response` |
| `core/ports` | `CodeHost` |
| `core/application` | `ScanIntake`, `RespondToReview` (collect/triage zapis), `ListMyPullRequests`, rozszerzenie `GenerateHostFiles` o MCP |
| `plugin-codehost-mcp` | `McpCodeHost` dla GitHub, GitLab, Jira (jeden adapter, trzy profile narzędzi), kontrakt + fixture'y |
| `runtime` | rejestracja, pętla `intake` w demonie (`--intake-ms`, domyślnie 120000) |
| `cli` | `metator intake scan\|rules\|status`, `metator mrs list\|show`, `metator generate` z MCP, `metator doctor` sprawdza MCP |
| `metator/agents` | `mt-orchestrator` z sekcją intake; nowy `mt-review-responder` |
| `desktop` | „+ New session” → pane; ekran **Open MRs**; formularz pod „zaawansowane” |
| `site/` | strony „Start from the agent”, „Automatic intake”, „Answer a review” |

## 6. Kryteria wyjścia fazy T
- T1: w aplikacji „+ New session” otwiera pane; w pane osoba zadaje pytanie o repo (odpowiedź z cytatami) i prosi o zmianę; agent zakłada run bez formularza; e2e na hoście scenariuszowym.
- T2: issue z etykietą w repozytorium testowym staje się sesją w ≤ 120 s; drugi skan nic nie dubluje; `autonomy: full` dochodzi do bramki push; e2e z fake MCP.
- T3: recenzja na MR tego repozytorium pojawia się w **Open MRs** w ≤ 120 s z planem i odpowiedziami; „Napraw” uruchamia build na gałęzi MR; e2e z fake MCP i jeden przebieg na prawdziwym PR MetatorAI (zrzuty).
- Zawsze: `bun run check` zielony, wersjonowane dokumenty z zamrożonymi schematami, mutanty dla nowych modułów, strony w `site/`.
