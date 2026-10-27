# Wiele repozytoriów, pytania do kodu i pełny interfejs terminala (analiza i plan)

Status: **zaakceptowany przez użytkownika** (2026-10-27). Realizacja etapami G1–G5.

## 1. Problem

Z rozmowy z użytkownikiem, w pięciu obszarach:

1. **Gdzie uruchamiać `metator`, gdy projektów jest kilka?**
   - W folderze nadrzędnym, w którym leżą wszystkie projekty, czy w każdym projekcie osobno?
   - Musi to być jasno udokumentowane.
2. **Trzy repozytoria, każde z własnym, niezależnym Metatorem**, na jednej maszynie. Czy architektura na to pozwala?
3. **Czy `metator ui` ma wszystko, czego trzeba do pełnego zarządzania pracą:**
   - postęp każdej sesji;
   - co i gdzie trzeba odpowiedzieć;
   - aplikacje, ustawienia.
4. **Zwykłe pytania do kodu:** „jak działa X”, „gdzie jest Y”, analiza bez feature'a i bez review.
5. **Interfejs klasy enterprise:**
   - pełnoekranowy, jak w Claude Code czy Copilot CLI, ale własny;
   - wszystkie akcje i ustawienia dostępne z jednego miejsca.

## 2. Weryfikacja stanu (2026-10-27)

| Obszar | Stan | Luka |
|--------|------|------|
| Korzeń repozytorium | `findRepoRoot`: najbliższy przodek z `.git` albo `metator.config.*`; bez nich katalog startowy | w folderze nadrzędnym bez `.git` folder jest traktowany jak repozytorium, więc komendy git zawodzą niejasno |
| Niezależne repozytoria | konfiguracja, kanon, runy, worktree i `EnvState` leżą w repozytorium; logi procesów mają katalog per repozytorium (F8.7) | **bloki portów** są dzierżawione w rejestrze repozytorium, więc dwa repozytoria mogą dostać ten sam blok; **projekt Compose** `metator-<miejsce>` jest taki sam w każdym repozytorium, więc kontenery dwóch repozytoriów się nadpisują |
| Wiele aplikacji | `SystemMap` (F7.1) opisuje aplikacje i kontrakty | nie ma pojęcia folderu z kilkoma checkoutami ani listy repozytoriów do pracy lokalnej |
| `metator ui` (F8.6) | menu na `@clack/prompts`: sesje, skrzynka pytań, aplikacje, edytor, powłoka, diff | brak postępu etapów, kontekstu pytania (etap, agent, artefakt), czasu, hosta i portów w jednym widoku; lista nie odświeża się sama; brak ustawień i pytań do kodu |
| Pytania do kodu | agenci workflowów, `graph`, `symbols`, `similar` | brak komendy rozmowy: pytanie, odpowiedź z cytatami `plik:linia`, dopytanie |

## 3. Koncepcja

### 3.1 Dwa sposoby pracy z wieloma repozytoriami

**A. Każde repozytorium osobno (domyślnie).**
- `metator setup` w każdym repozytorium. Każde ma własny `metator.config.yml`, kanon, runy i środowisko.
- `metator` uruchamia się **wewnątrz repozytorium** (albo z `-C <repozytorium>`).
- Na jednej maszynie repozytoria nie mogą się kolidować:
  - **dzierżawy portów dla całej maszyny** (`PortLeases` v1 w katalogu stanu użytkownika: `$METATOR_STATE_DIR`, potem `$XDG_STATE_HOME/metator`, potem `~/.local/state/metator`). Blok portów jest wolny tylko wtedy, gdy nie trzyma go żadne repozytorium na tej maszynie. Wpis repozytorium, którego już nie ma, nie blokuje bloku.
  - **projekt Compose per repozytorium:** `metator-<slug repozytorium>-<hash>-<miejsce>`.

**B. Folder z repozytoriami (opcjonalnie).**
- Plik `metator.repos.yml` (`RepoSet` v1) w folderze nadrzędnym wymienia repozytoria. `metator repos init` proponuje go z podkatalogów, które mają `.git`.
- Każde repozytorium dalej ma własnego Metatora (tryb A). Folder **niczego nie współdzieli**, tylko je zbiera.
- W folderze działają komendy, które dotyczą wielu repozytoriów:
  - `metator ui`: sesje ze wszystkich repozytoriów;
  - `metator repos list|status`;
  - `metator ask`: pytanie o kod wszystkich repozytoriów.
- Pozostałe komendy (np. `run init`, `env up`) w folderze kończą się `USAGE` z podpowiedzią: uruchom w repozytorium albo podaj `-C <repo>`.
- Wewnątrz repozytorium leżącego w folderze wygrywa najbliższy `.git`: komendy działają na tym repozytorium.

| Gdzie uruchamiasz | Co jest korzeniem | Co działa |
|-------------------|-------------------|-----------|
| wewnątrz repozytorium (albo `-C repo`) | to repozytorium | wszystko |
| folder z `metator.repos.yml` (albo folder bez `.git` z repozytoriami pod spodem) | folder | `ui`, `repos`, `ask`; reszta: podpowiedź `-C` |

Relacja z `SystemMap`: mapa systemu opisuje **co** wdrażamy i jakie kontrakty łączą aplikacje. Folder repozytoriów mówi tylko, **gdzie** na dysku leżą checkouty. F7.3 (`system impact`) użyje folderu jako źródła lokalnych checkoutów.

### 3.2 Pytania do kodu: `metator ask`

- `metator ask "Jak liczony jest rabat?"`:
  - uruchamia agenta **`mt-guide`** przez port `AgentHost` (ten sam co w runach, więc działa z Claude Code, Copilot i hostem scenariuszowym);
  - agent tylko czyta: `Read`, `Glob`, `Grep` i komendy `metator graph|symbols|similar|cards|rules show`;
  - odpowiada z cytatami `plik:linia`.
- `--continue [id]` dopytuje w tej samej rozmowie i wznawia sesję hosta.
- **`Conversation` v1** (`.metator/conversations/<id>.json`): pytania i odpowiedzi z czasem, host i sesja hosta. Rozmowa to sesja: widać ją w `metator ui` i można ją kontynuować.
- W folderze repozytoriów agent dostaje folder jako katalog pracy, więc może czytać wszystkie repozytoria.
- Bez terminala zwraca kopertę z odpowiedzią. W terminalu tekst płynie na żywo.

### 3.3 Przegląd pracy: `metator status`

Jeden use case (`WorkOverview`) zbiera wszystko, czego potrzebuje człowiek:
- każdy run:
  - workflow, etapy z ich stanem (zrobiony, bieżący, czeka na człowieka, przyszły), autonomia, host;
  - czy drive żyje, otwarte pytania z kontekstem, ostatnia aktywność i czas;
  - worktree (gałąź, porty) i usługi z ich stanem;
- rozmowy;
- w folderze: wszystko to dla każdego repozytorium.

`metator status` zwraca to jako kopertę JSON. TUI czyta te same dane, więc to, co widać, da się też przetestować bez terminala.

### 3.4 Interfejs terminala na Ink

**Wybór biblioteki** (ADR-0010: gotowy pakiet):

| Kandydat | Za | Przeciw |
|----------|----|---------|
| **Ink 8** (React w terminalu) | dojrzały; używają go Claude Code, Copilot CLI i Gemini CLI; flexbox (Yoga); `ink-testing-library` do testów komponentów; działa pod Bun 1.4 (sprawdzone spike'iem) | renderowanie do ~30 kl./s, co przy panelach tekstowych wystarcza |
| OpenTUI (`@opentui/core` 0.7) | szybki rdzeń w Zig, Bun-first, używany przez OpenCode | wersja 0.x z wydaniem sprzed 2 dni, warstwa natywna (FFI), peer `web-tree-sitter` |
| blessed / neo-blessed | dużo widgetów | nierozwijany |
| `@clack/prompts` (obecnie) | proste kreatory | brak układu ekranu, paneli i odświeżania na żywo |

Decyzja: **Ink 8 + React 19.3**. `@clack/prompts` zostaje dla `metator setup` i kreatora `metator run`.

**Układ ekranu:**

```
┌ MetatorAI · shop (3 repos) ───────────── 2 need you · 1 driving · 4 services ┐
│ SESSIONS            │ 20261027-mt-feature-combined-discount   orders · claude │
│ orders              │ intake ✓ ─ context ✓ ─ plan ✓ ─ [plan-approval ?] ─ build│
│  ? combined-disc.   │ ⏵ waits for you: approve the plan (3 min)                │
│  ⟳ fix-rounding     │ ── Activity ─────────────────────────────────────────── │
│ billing             │ 10:41 mt-planner  wrote plan.json (5 steps)              │
│  ✓ docs-links       │ 10:42 gate plan-lint ✓                                   │
│ CHATS               │ ── Apps ─────────────────────────────────────────────── │
│  ✦ how is VAT…      │ db ● shared :5432   api ● :41000   web ○                 │
├─────────────────────┴─────────────────────────────────────────────────────────┤
│ ⏎ open  a answer  n new run  ? ask  s apps  e editor  t shell  d diff  : all  │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Lista sesji** z lewej:
  - runy pogrupowane po repozytorium i posortowane: najpierw „czeka na ciebie”, potem „pracuje”, „zatrzymany”, „gotowy”;
  - pod spodem rozmowy;
  - liczniki w nagłówku i dzwonek przy nowym pytaniu.
- **Szczegóły** z prawej, w zakładkach:
  - Overview: pasek etapów, host, autonomia, worktree, porty, czas;
  - Activity: na żywo;
  - Questions: odpowiedź w miejscu;
  - Apps;
  - Changes (diff stat);
  - Chat (dla rozmowy).
- **Paleta komend** (`:` albo Ctrl+K): każda akcja z filtrem, czyli nowy run, pytanie, odpowiedź, kontynuacja, stop, aplikacje, worktree, pula, analiza startu, ustawienia, aktualizacja agentów.
- **Ustawienia:**
  - edytor, hosty AI (`hosts.targets`) i domyślny host nowych runów;
  - zapis przez `UpdateConfig`, który zachowuje komentarze;
  - po zmianie hostów proponuje `agents update`.
- Edytor, powłoka i `git diff` dostają terminal na wyłączność (Ink się zawiesza i wraca).
- Bez terminala `metator ui` zwraca `USAGE` z odsyłaczem do `metator status`.

## 4. Etapy

| Etap | Produkt | Kryterium wyjścia |
|------|---------|-------------------|
| **G1** niezależne repozytoria | `PortLeases` v1 (cała maszyna), projekt Compose per repozytorium | e2e: dwa repozytoria na jednej maszynie dostają rozłączne bloki portów i różne projekty Compose |
| **G2** folder repozytoriów | `RepoSet` v1, `repos init|list|status`, komendy świadome folderu, podpowiedź `-C` | e2e: folder z trzema repozytoriami: `repos list` pokazuje wszystkie, `run init` w folderze daje podpowiedź, w repozytorium działa |
| **G3** `metator ask` | `mt-guide`, `Conversation` v1, `ask`, `ask --continue`, `ask list` | e2e na hoście scenariuszowym: pytanie, odpowiedź z cytatem, dopytanie w tej samej sesji hosta |
| **G4** `metator status` | `WorkOverview` | e2e: dwa runy (czekający i zatrzymany), rozmowa, usługi; w folderze dla każdego repozytorium |
| **G5** TUI | `metator ui` na Ink: panele, paleta komend, ustawienia | testy komponentów (`ink-testing-library`) i e2e w pseudo-terminalu: wybór sesji, odpowiedź, pytanie do kodu, start aplikacji, zmiana ustawień |

Każdy etap kończy się aktualizacją strony z dokumentacją (`site/`).
