# Faza S: system opcji, podgląd planu, lokalne zadania, przegląd kodu

Status: **zaakceptowany** (makiety v9, 2026-11-09). Wzorzec: herdr (konfiguracja, obsługa pane'ów, worktree), przeniesiony na model MetatorAI: workflow jest prawem, agent decyduje w jego granicach, człowiek zatwierdza. Każdy punkt S1–S6 to osobna gałąź i osobny PR do `main`, otwierany po zielonym `bun run check` i e2e tego punktu.

## 0. Czego nauczyliśmy się z herdr

herdr trzyma jedną konfigurację użytkownika w TOML (`~/.config/herdr/config.toml`, nadpisanie ścieżki przez `HERDR_CONFIG_PATH`), ładowaną z diagnostyką (zła wartość = ostrzeżenie i wartość domyślna, nie błąd startu), przeładowywaną na żywo (`prefix+shift+r`) i eksportowaną klientom jako „profil” (`local_keybindings_profile_toml`). Nie ma w nim konfiguracji per projekt; jedyne nadpisanie lokalne to manifesty detekcji agentów (`~/.config/herdr/agent-detection/<agent>.toml`).

Inwentarz sekcji i opcji (wersja 0.9.x):

| Sekcja | Opcje (wybór) | Co z tego bierzemy |
|---|---|---|
| `[ui]` | `sidebar_width/min/max`, `sidebar_start_collapsed`, `sidebar_collapsed_mode`, `pane_borders` (auto/always/off), `pane_outer_borders`, `pane_scrollbars`, `pane_gaps`, `show_agent_labels_on_pane_borders`, `tab_bar_position`, `hide_tab_bar_when_single_tab`, `tab_bar_right` (wpisy statusu), `window_title` (szablon `{hostname}: {workspace}`), `agent_panel_sort` (spaces/priority), `status_indicators` (dots/symbols), `accent`, `confirm_close`, `prompt_new_tab_name`, `prompt_new_workspace_name`, `copy_on_select`, `mouse_capture`, `host_cursor` | wygląd paneli i pasków, sortowanie panelu sesji, potwierdzenia, akcent, tytuł okna |
| `[ui.toast]` | `delivery` (off/herdr/terminal/system), `delay_seconds`, pozycje | kanał i opóźnienie powiadomień |
| `[keys]` | `prefix` (jeden lub lista), ~60 akcji (`new_tab`, `split_vertical`, `zoom`, `copy_mode`, `focus_pane_*`, `swap_pane_*`, `resize_pane_*`, `goto`, `detach`, `reload_config`), `[[keys.command]]` własne komendy (`key`, `command`, `type = "popup"`, `description`) | skróty jako opcje z domyślnymi; własne komendy jako akcje użytkownika |
| `[theme]` | motyw jasny/ciemny, nadpisania kolorów (`sidebar_bg`, `selection_bg`, tokeny paska bocznego z `hide`) | motyw i kilka tokenów |
| `[terminal]` | `default_shell`, `shell_mode` (auto/login/non_login), `new_cwd` (follow/home/current/ścieżka), `kitty_graphics` | powłoka pane'a shell, katalog nowego pane'a |
| `[session]` | `resume_agents_on_restore`, `startup_per_agent_delay_ms` | wznawianie po restarcie demona (mamy), odstęp startu |
| `[server]` | `headless_cols/rows`, `allow_unelevated_clients` | rozmiar PTY bez klienta |
| `[update]` | `channel` (stable/preview), `version_check`, `manifest_check` | kanał i sprawdzanie wersji (gdy będzie paczka) |
| `[remote]`, `[worktrees]` | `manage_ssh_config`, `worktrees.directory` | katalog worktree'ów (mamy `.metator/wt`) |
| `[experimental]` | flagi eksperymentów | sekcja `experimental` jako miejsce na flagi bez wersji schematu |
| `[[startup]]` | hooki przywracania stanu pluginów | nie teraz |

Czego herdr nie ma, a my mamy i zostawiamy: konfiguracja **per repozytorium** (`metator.config.yml`: bramki, hosty, ścieżki, supervisor, notify), wersjonowane dokumenty ze schematem i migracją (ADR-0016), workflow jako prawo.

## 1. S1: system opcji

### Cel
Jedno miejsce definicji każdej opcji (typ, domyślna, opis, zakres, czy wymaga restartu), jedna odpowiedź na „jaka jest wartość tutaj” (z nałożeniem zakresów) i jeden UI do zmiany (CLI, demon, aplikacja), bez dotykania `MetatorConfig` v7 przy każdej nowej opcji.

### Model
- **`OptionDefinition<T>`** (domena, `packages/core/src/domain/options.ts`): abstrakcyjna klasa z `key` (kropkowana, np. `ui.paneBorders`), `scope` (`user | repo | run`), `schema` (zod), `default`, `title`, `description`, `restart` (`none | daemon | app`), `since` (wersja). Podklasy: `BooleanOption`, `EnumOption`, `NumberOption` (min/max, jednostka), `StringOption`, `ListOption`, `KeybindingOption` (walidacja akordu), `CommandOption` (komenda powłoki, z adnotacją „uruchamiana lokalnie”). Rejestr `OPTIONS` jest listą definicji; test pilnuje unikalności kluczy i tego, że każda opcja ma opis i domyślną.
- **Dokumenty**: `UserOptions` v1 w `~/.config/metator/options.yml` (zakres `user`: wygląd, skróty, powiadomienia, edytor, powłoka), `RepoOptions` jako sekcja `options:` w `metator.config.yml` v8 (zakres `repo`: supervisor, hosty, worktree'y; dzisiejsze pola zostają, nowe idą do `options`), nadpisania runu w `RunRecord` (`options`, zakres `run`, np. host, autonomy, bez wersji nowej: pole opcjonalne w v7? nie: `RunRecord` v8 z migracją). Każdy plik: `kind` + `schemaVersion`, zamrożony schemat.
- **Nałożenie** (`application/options.ts`, `OptionStore`): `resolve(key, {runId?})` → `{value, source: default|user|repo|run, definition}`; `set(key, value, scope)`; `list(scope?)` z efektywnymi wartościami i źródłem; `diagnostics()` jak w herdr: nieznany klucz, zła wartość → ostrzeżenie, wartość domyślna, nic nie blokuje startu. Zmiana zapisuje plik; klienci odczytują `/options` cyklicznie (bez osobnego gniazda); opcje `restart: daemon` są oznaczone w UI.
- **Powierzchnie**: `metator config get <key> [--run]`, `metator config set <key> <value> --scope user|repo|run`, `metator config list [--scope] [--changed]`, `metator config schema` (JSON Schema złożony z rejestru); demon `GET /options`, `PUT /options/:key`; aplikacja: ekran **Settings** (szukajka, grupy wg prefiksu, wartość, źródło, „przywróć domyślną”, znacznik „wymaga restartu”); TUI `metator ui` czyta te same opcje.

### Opcje do wdrożenia w S1 (pierwsza lista, każda z domyślną)
- `ui.theme` (`system|dark|light`), `ui.accent` (kolor), `ui.density` (`compact|comfortable`), `ui.paneBorders` (`auto|always|off`), `ui.paneLabels` (bool), `ui.sidebarWidth`, `ui.sidebarStartCollapsed`, `ui.panelSort` (`attention|updated`), `ui.statusIndicators` (`dots|symbols`), `ui.confirmClosePane`, `ui.windowTitle` (szablon), `ui.openOnStart` (`inbox|last`).
- `keys.*`: `prefix` (lista), `detach`, `newShell`, `focusPane.{left,down,up,right}`, `zoom`, `nextWaiting`, `attach`, `release`, `events`, `goto`; `keys.command[]` (własne akcje: `key`, `command`, `title`, `popup`).
- `notify.channel` (`off|app|system|command`), `notify.command` (dziś `notify.command`), `notify.delaySeconds`, `notify.sound`.
- `terminal.shell`, `terminal.shellMode` (`auto|login|nonLogin`), `terminal.newPaneCwd` (`worktree|repo|home`), `terminal.headless` (`cols`, `rows`), `terminal.scrollbackBytes`.
- `editor.command` (dziś `editor`), `editor.openWith` (`workspace|folder`), `editor.diffTool`.
- `supervisor.*` (istniejące: `wipLimit`, `respawn.enabled`, `respawn.maxAttempts`, `idleThresholdMs`, `hostOrder`, `chatApprovals`) oraz `supervisor.resumeConductors`, `supervisor.startupDelayMs`.
- `hosts.default`, `hosts.manifestsDir` (dziś `metator/hosts`), `hosts.models.{copilot,claude}`.
- `worktrees.directory`, `worktrees.removeOnClose` (`ask|always|never`), `worktrees.installDependencies` (`copy|install|none`).
- `review.autoOpenEditor` (bool), `review.sendTo` (`conductor|worker`) (dla S5), `issues.requireConsent` (zawsze `true`, nie do zmiany: wyświetlana, nie edytowalna), `issues.proposeFromAgents` (bool) (dla S4).
- `experimental.*` jako wolna mapa flag (`BooleanOption` rejestrowana w locie z ostrzeżeniem w diagnostyce).

## 2. S2: podgląd planowania i postępu

### Cel
Widok „gdzie jesteśmy i co zostało”: etapy workflow, kroki planu (`plan.json`), kto nad czym pracuje (pane'y), co czeka (pytania, bramki), co już jest (artefakty, wyniki workerów), interaktywnie i na żywo.

### Dane (nic nowego do wymyślania)
`RunRecord` (etapy, status), `Plan` v1 (kroki z plikami, testami i regułami), `plan-progress` (istnieje: które kroki zrobione na podstawie zmian i testów), `RunActivity`, `Question`, `WorkerResult`, `Layout`/sensor (pane'y i stany), `gates/*.json`. Nowy dokument tylko jeden: **`PlanBoard`**? nie: widok jest złożeniem, demon daje `GET /runs/:id/board` (use case `PlanBoard.execute`) jako projekcję, bez pliku.

### Ekran **Plan** (aplikacja, `#/plan/<run>`)
- Pasek etapów z czasem w każdym i kto go wykonał (agent, pane).
- Lista kroków planu: status (`todo | in-progress | done | blocked`), plik, testy, reguły, exemplar, wynik gate'a; klik → diff pliku (S5) albo pane workera.
- Kolumna „czeka na”: pytania i bramki z akcjami karty decyzji (ta sama karta co w inboxie).
- Oś czasu z `RunActivity` filtrowana po etapie; „co dalej”: następny etap, jego agenci, warunki wyjścia z workflow (`done:`).
- Interakcje: zatwierdź plan (`run approve plan-approval`), odpowiedz, otwórz pane, dodaj zadanie do backlogu (S4) z kontekstem kroku, dodaj komentarz do pliku (S5).
- CLI: `metator run board [--run]` (JSON tej samej projekcji) i `metator run board --watch` w TUI.

## 3. S3: PR per feature (proces, nie kod)

- Gałąź `claude/s<N>-<slug>` z `main`; PR do `main` przez GitHub MCP, merge po zielonym CI, otwierany przeze mnie, gdy punkt ma: testy jednostkowe, e2e, mutanty, docs w `site/`, zielone `bun run check`; opis PR z sekcjami „Co”, „Jak sprawdzić”, „Ryzyka”, link do tego dokumentu; `mt-pr-review.yml` (akcja MetatorAI z komentarzem podsumowania) i `ci.yml` biegną na PR.
- Subskrypcja PR: po otwarciu pilnuję CI i komentarzy (`subscribe_pr_activity`); merge robisz Ty.
- Kolejność: S1 → S2 → S4 → S5 (S5 zależy od S1 `editor.*`); S3 obowiązuje od pierwszego.

## 4. S4: lokalne zadania (backlog)

### Cel
Rzecz zauważona w trakcie feature'a nie ginie: trafia do lokalnego backlogu **za Twoją zgodą**, jasno opisana, powiązana z runem, plikiem i krokiem, do podjęcia później jako nowy run.

### Model
- **`Issue` v1** w `.metator/issues/i001.json`: `id`, `title`, `body` (co i dlaczego, kryterium akceptacji), `origin` (`person | agent:<id> | run:<id>`), `refs` (pliki z liniami, run, krok planu, pytanie), `labels`, `priority` (`low|normal|high`), `status` (`proposed | open | in-progress | done | dropped`), `createdAt`, `decidedBy/At`, `runId?` (gdy podjęte). Zamrożony schemat.
- **Zgoda**: agent nie tworzy zadania. `metator issue propose --title --body --ref …` (dozwolone w hookach dla workera i dyrygenta) zapisuje `status: proposed` i **pytanie w inboxie** (`source: agent`, opcje: „Dodaj do backlogu”, „Dodaj i wyceń priorytet…”, „Odrzuć”); Twoja odpowiedź zmienia status (`open`/`dropped`) i wpisuje `decidedBy`. Ty tworzysz bezpośrednio: `metator issue add` (CLI, TUI, aplikacja: przycisk „+ Zadanie” w sesji, planie i przeglądzie kodu z automatycznym `refs`).
- **Powierzchnie**: `metator issue list|show|edit|close|drop|start <id>` (`start` = `run init --workflow … --task "<title>\n\n<body>" --from-issue`, a issue dostaje `runId` i `in-progress`); demon `GET/POST /issues`; aplikacja: ekran **Backlog** (`#/backlog`) z filtrami i kartą zadania, licznik w szynie; MCP: `metator_issue_list|show` (czytanie).
- **Zasady**: `issues.requireConsent` zawsze prawdziwe; propozycje liczą się do budżetu uwagi jak pytania; zadanie bez kryterium akceptacji dostaje ostrzeżenie `task-lint`.

## 5. S5: podgląd kodu: VS Code i wewnętrzny przegląd z komentarzami

### Cel
Z poziomu pane'a lub runu: jeden klik otwiera worktree/branch w VS Code na zmianach; wewnątrz aplikacji przegląd diffu z komentarzami, które jednym przyciskiem trafiają do agenta jako Twój input do review.

### Otwieranie w edytorze
- Demon: `POST /runs/:id/open-editor` i `POST /panes/:id/open-editor` → `editor.command` z `OptionStore` (domyślnie `code`), argumenty: katalog worktree (lub repo) + `--goto <plik>:<linia>` gdy podano; dla VS Code dodatkowo `code --diff` dla pary plików i `code -r` (reuse window) wg `editor.openWith`. Zapis w aktywności runu (`origin: inbox`).
- Aplikacja: przycisk „Open in VS Code” w pasku pane'a, w nagłówku sesji (worktree runu) i w przeglądzie zmian (plik, linia). TUI ma już `e` (edytor) na tym samym use case.

### Wewnętrzny przegląd (ekran **Review**, `#/review/<run>`)
- Dane: `metator review diff --base <base>` (istnieje) per plik, lista plików z `metator changed`, status kroków planu per plik; baza = `origin/<base>` runu albo `HEAD` checkoutu.
- Widok: lista plików (zmienione, dodane, usunięte, z liczbą + / −), diff dwukolumnowy lub inline z podświetleniem składni (CodeMirror 6 w aplikacji; ADR na zależność), komentarze inline: klik na linię → pole komentarza; komentarze ogólne do pliku i do całości.
- **`ReviewNote` v1** w `.metator/runs/<id>/review/notes.json`: `id`, `file`, `line?`, `side` (`old|new`), `text`, `by`, `at`, `status` (`draft | sent | addressed`), `sentIn?` (id wiadomości). Zamrożony schemat.
- **Wyślij do agenta**: przycisk „Send to agent” → `metator run message --to <run> --topic review --text <zebrane notatki jako lista: plik:linia, cytat, uwaga>` (`RunMessage` istnieje); dyrygent dostaje wiadomość w kolejnym `run status`/`run messages` (już czyta wiadomości), worker przez kartę przy kolejnej delegacji; opcja `review.sendTo`. Notatki zmieniają status na `sent`; gdy agent odpisze (`run message --topic review-reply`) lub plik się zmieni w tych liniach, aplikacja oznacza `addressed` do potwierdzenia przez Ciebie.
- CLI: `metator review notes list|add|send` (to samo bez aplikacji), MCP `metator_review_notes_list` (czytanie) dla agenta w innym hoście.

## 5b. S6: siatka terminali jak w herdr (parytet workbencha)

### Cel

Osoba patrzy na sesję Copilot CLI tak, jakby sama uruchomiła ją w konsoli: pełny ekran agenta w kafelku, bez pośrednika. To już działa (R2–R5: PTY + xterm.js). Brakuje tego, co w herdr czyni siatkę wygodną: pisanie wprost w kafelku, zoom, podział i przeciąganie, tryb kopiowania, skróty jak w tmux.

### Co dochodzi

| Element | herdr | MetatorAI dziś | S6 |
|---|---|---|---|
| Pisanie w kafelku | zawsze, agent i człowiek dzielą klawiaturę | tylko po `attach` (klawiatura jest agenta albo osoby) | klik w kafelek = fokus; klawisze idą do PTY, jeśli pane ma `owner: human` lub jest shellem; dla pane agenta pierwszy klawisz pyta „Przejąć?” (`ui.attachOnType`: ask / always / never) |
| Zoom | `prefix+z` kafelek na cały obszar | brak | `Layout.zoom: paneId \| null` w Layout v2 (migracja), `prefix+z`, podwójny klik w ramkę |
| Podział i układ | split, resize, drag | siatka automatyczna 1/2/4 | `Layout.tree` (binary split tree: `{dir, ratio, a, b}` albo `{paneId}`), `prefix+v` / `prefix+-`, przeciąganie krawędzi; układ zapisany w Layout v2, przywracany po restarcie |
| Tryb kopiowania | `prefix+[`, wyszukiwanie w scrollbacku, vim-klawisze | zaznaczanie myszą w xterm.js | `prefix+[`: xterm.js SearchAddon, zaznaczanie klawiaturą, `y` kopiuje, `/` szuka; `terminal.scrollback` z S1 |
| Ramki i etykiety | ramka z nazwą agenta, stanem i gałęzią | nazwa + stan w zakładce | ramka kafelka z `ui.paneBorders` (auto/always/off) i `ui.paneLabels` (agent · rola · stan sensora · gałąź) |
| Skróty | `[keys]` w TOML, ~60 akcji | stałe w kodzie | wszystkie akcje przez `keys.*` z S1 (`KeybindingOption`), `[[keys.command]]` → `keys.command[]` (popup lub pane) |
| Go-to picker | `prefix+g`, filtry b/w/i/d | brak | ekran GoTo (makieta): agenci i terminale po workspace'ach, filtry stanu, pytania z inboxu, `↵` skok, `a` attach |
| Status line | tokeny konfigurowalne | pasek stanu stały | `ui.statusLine[]` (tokeny: zoom, hostname, datetime, text, command) |

### Dane

`Layout` v2 = v1 + `tree` i `zoom`; migracja z v1 buduje drzewo z kolejności pane'ów (podział naprzemienny). Reszta to opcje z S1 i zdarzenia w aplikacji; demon nie wie o zoomie ani fokusie, zapisuje tylko `tree`.

### Kryterium wyjścia

e2e: `layout split w1:p1 --dir vertical` tworzy drzewo i jest widoczne po restarcie demona; w aplikacji (Playwright): klik w shell i wpisanie `echo hi` daje wynik w PTY bez `attach`; `prefix+z` pokazuje jeden kafelek, drugi raz przywraca siatkę; tryb kopiowania znajduje tekst w scrollbacku. Mutanty na migracji Layout v1→v2 i na drzewie podziału.

## 5c. Makiety do akceptacji (co osoba widzi)

Canvas: <https://claude.ai/artifact/797oXryHh2ncr9mVts8W1B> (prywatny, 7 artboardów 1440×900, wersja 9).

Zasada: **workbench = herdr, nic więcej na ekranie**. Jedna czcionka (mono), sidebar z numerowanymi workspace'ami i gałęzią, lista agentów ze stanem (✓ idle, ⋮ working, ! blocked, ? pyta), surowe terminale w ramkach z nazwą agenta, status line, jeden toast. Drugi poziom informacji jest na ekranie tylko tam, gdzie oszczędza kliknięcie: stan w ramce pane'a, krok przy agencie, bieżący krok w pasku procesu, opis pod nazwą opcji, liczby `+/−` przy pliku. Akcje są pod prawym przyciskiem albo na osobnym, cienkim ekranie.

Model ekranu (zgodny z `Layout` v1 z R1, doprecyzowany):

- **workspace** = repozytorium (sidebar, numer, gałąź bazowa, kropka uwagi zbiorcza);
- **tab** = zadanie: własny worktree, gałąź i run (`Tab.worktree`, `Tab.runId`, oba opcjonalne; tab bez nich to zwykły shell). Pasek tabów pokazuje nazwę i gałąź. Nowy tab z menu: shell, zadanie w nowym worktree, zadanie z backlogu;
- **pane** = terminal w tabie (agent albo shell), siatka z podziałem jak w herdr.

Stan po konsolidacji (2026-11-13, [design/12 §5.0](12-desktop.md)): workbench nazywa się w aplikacji **Terminals** i nie ma własnego sidebara. Lista agentów ze stanem jest w jednym pasku bocznym aplikacji (pane'y pod runem); przełącznik workspace'ów, gdy jest ich więcej niż jeden, to lista wyboru na początku paska tabów. Ekrany Plan i Zmiany są zakładkami strony runu. GoTo, menu, zoom, podział i tryb kopiowania bez zmian; `prefix+?` i `?` otwierają listę klawiszy z filtrem.

Pod paskiem tabów jest **pasek procesu aktywnego taba**: etapy workflow w jednej linii (`intake ✓ · context ✓ · plan ✓ · approval ✓ · build ▸ 2/4 · gates · review · delivery`), po prawej liczba pytań, ścieżka worktree i przycisk **VS Code** (widoczny, gdy tab ma worktree albo gałąź). Klik w etap otwiera ekran Plan. Dla taba bez runu pasek jest pusty poza ścieżką i VS Code.

| Artboard | Co pokazuje |
|---|---|
| **Main** | workbench jak herdr; taby = zadania (discount · run/discount-10, pdf-cents, shell); pasek procesu pod tabami z VS Code; 2×2 terminale Copilot CLI widoczne jak w konsoli; toast z pytaniem hosta (`↵` odpowiedz) |
| **Menu** | prawy klik na pane: odpowiedz tutaj, przejmij klawiaturę, zoom, podziel, plan runu, zmiany, VS Code, nowe zadanie stąd, zamknij; prawy klik na tab: nowy tab (shell / zadanie w nowym worktree / zadanie z backlogu), zmień nazwę, zamknij tab i usuń worktree. Te same akcje pod `prefix` + klawisz |
| **GoTo** | `prefix+g`: jedno pole, lista agentów i terminali po numerach workspace'ów, pytania jako wiersze, filtry `b w i d` |
| **Plan** | lista kroków po lewej, jeden krok po prawej (plik, testy, wzorzec, reguły, krytyk), pasek etapów w jednej linii, „czeka na ciebie” na dole listy |
| **Zmiany** (review) | lista plików, diff, uwaga jako linia pod kodem, jeden przycisk „Wyślij N uwag”, „VS Code” |
| **Backlog** | propozycje agentów i otwarte zadania w jednej liście; po prawej treść i trzy przyciski (Dodaj / Dodaj i zacznij run / Odrzuć) |
| **Ustawienia** | sekcje po lewej, w sekcji lista „nazwa · wartość · źródło”, zła wartość podpisana na bursztynowo zamiast błędu |

Implementacja fazy S zaczyna się po akceptacji makiet. Każdy artboard to jeden plik HTML, poprawki są tanie.

## 6. Architektura w kodzie (gdzie co leży)

```
packages/core/src/domain/options.ts          OptionDefinition i podklasy, rejestr OPTIONS, UserOptions v1, nałożenie
packages/core/src/domain/issue.ts            Issue v1
packages/core/src/domain/review-note.ts      ReviewNote v1
packages/core/src/application/options.ts     OptionStore (resolve/set/list/diagnostics) nad FileSystem (user dir przez port)
packages/core/src/application/issues.ts      Issues (propose → pytanie, add, decide, start → InitRun)
packages/core/src/application/plan-board.ts  PlanBoard (projekcja runu: etapy, kroki, pane'y, pytania, artefakty)
packages/core/src/application/review-notes.ts ReviewNotes (list/add/send → RunMessages, addressed)
packages/core/src/application/open-editor.ts OpenEditor (editor.* + ProcessRunner; worktree/plik/diff)
packages/cli/src/commands/config.ts          get|set|list|schema (rozszerzenie istniejącego)
packages/cli/src/commands/issue.ts, review.ts (notes), run.ts (board)
packages/cli/src/serve/server.ts             /options, /issues, /runs/:id/board, /runs/:id/review/*, open-editor
packages/desktop/src/screens/settings.tsx, plan.tsx, backlog.tsx, review.tsx, goto.tsx
packages/core/src/domain/layout.ts          Layout v2 (tree, zoom) + migracja z v1 (S6)
packages/desktop/src/screens/terminals.tsx   drzewo podziału, zoom, pisanie w kafelku, tryb kopiowania (S6)
```

Porty: nowy port `UserConfigDir` (ścieżka katalogu użytkownika, w testach pamięciowa) i istniejące `FileSystem`, `ProcessRunner`. Żadna nowa zależność poza CodeMirror 6 (aplikacja, ADR) i ewentualnie `diff` (już w repo? sprawdzić w rejestrze) do dwukolumnowego widoku.

## 7. Kolejność i kryteria wyjścia

Kolejność: S1 → S6 → S2 → S4 → S5. S6 idzie zaraz po S1, bo zależy od `keys.*` i `ui.*`, a siatka terminali jest funkcją kluczową.

| Punkt | PR | Kryterium wyjścia |
|---|---|---|
| S1 | `claude/s1-options` | `config list` pokazuje każdą opcję z wartością i źródłem; zmiana w aplikacji widoczna w CLI bez restartu; zła wartość = ostrzeżenie, nie awaria; schematy zamrożone |
| S2 | `claude/s2-plan-board` | ekran Plan odświeża się na żywo w e2e (krok `in-progress` → `done` po wyniku workera); `run board` zgadza się z ekranem |
| S4 | `claude/s4-issues` | agent proponuje → pytanie w inboxie → zgoda tworzy `open`; `issue start` tworzy run powiązany; MCP czyta backlog |
| S6 | `claude/s6-grid` | pisanie w kafelku bez `attach`; `prefix+z` zoom i powrót; podział zapisany w Layout v2 i przywrócony po restarcie; tryb kopiowania z wyszukiwaniem |
| S5 | `claude/s5-review` | „Open in VS Code” uruchamia `editor.command` z worktree i `--goto`; notatki inline wysłane jako `RunMessage` i widoczne w `run messages`; `addressed` po zmianie linii |

Poza zakresem fazy S: podpisywanie instalek, remote/SSH jak w herdr, pluginy.
