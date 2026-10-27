# ADR-0054: `metator ui`, edytor w konfiguracji i port `Launcher`

- Status: Proposed
- Data: 2026-10-27

## Kontekst
Po F8.2–F8.5 człowiek może mieć kilka runów naraz, każdy w swoim worktree i ze swoimi aplikacjami. Każdy z nich obsługuje osobna komenda (`run continue`, `run answer`, `env up`, `worktree list`). Brakowało jednego miejsca, które pokazuje wszystkie sesje, a dla każdej pozwala odpowiedzieć na pytania, uruchomić aplikacje, otworzyć kod w edytorze lub powłoce i zobaczyć diff. Plan: [design/09 §3.7](../design/09-workspaces-sessions.md), decyzja 6 (edytor wykrywany, wybierany z listy i zapisany jako `editor`).

## Decyzja
- **`metator ui`** to hub z menu na `@clack/prompts` (port `Terminal` z ADR-0052, rozszerzony o `choose` i `bell`):
  - lista sesji (run, etap, stan), „New run”, „Questions (n)” i „Quit”; dzwonek, gdy przybędzie pytań;
  - menu sesji: Watch live, Continue the run, Answer questions, Applications, Open in editor, Shell here, Diff, Stop the drive;
  - aplikacje sesji przez `EnvironmentServices` worktree runu: start i stop wszystkich lub jednej usługi, logi, otwarcie URL (`xdg-open`/`open`);
  - diff względem merge-base worktree z HEAD głównego checkoutu.
- Bez terminala `metator ui` zwraca `USAGE`. Koperta po wyjściu podaje odwiedzone runy.
- **`MetatorConfig` v3** dodaje opcjonalne `editor`. Każdy plik v2 jest poprawnym v3 (migracja tożsamościowa, zamrożony snapshot).
- **Wybór edytora** (`domain/editors.ts`): `editor` z konfiguracji, potem `$VISUAL`, potem `$EDITOR`. Gdy żadnego nie ma, lista znanych edytorów z `PATH`. Wybrany edytor zapisuje use case `SetEditor`: YAML przez `updateYamlFields` (zachowuje komentarze), JSON albo nowy `metator.config.yml`. Edytory terminalowe przejmują terminal, okienkowe startują odłączone.
- **Port `Launcher`** (`attached`, `detached`, `available`) i adapter `BunLauncher` w plugin-bun. Programy człowieka (edytor, powłoka, `git diff`, przeglądarka) nie są wywołaniami narzędzi z wynikiem, więc nie idą przez `ProcessRunner`.

## Konsekwencje
### Pozytywne
- Jedna komenda do pracy z wieloma runami równolegle; wszystko, co robi, ma też odpowiednik bez terminala.
- e2e w pseudo-terminalu przechodzi całą ścieżkę: bramka, wybór i zapis edytora, start aplikacji.
### Negatywne
- To menu, a nie pełnoekranowy układ paneli (Ink): widok sesji na żywo zajmuje cały ekran, a lista nie odświeża się sama. Wystarcza na teraz; panele można dodać bez zmiany dokumentów i portów.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Pełnoekranowy TUI na Ink | nowa zależność i inny model testów; menu na clack daje te same akcje |
| Edytor tylko z `$EDITOR` | `$EDITOR` to zwykle edytor terminalowy; ludzie chcą otwierać worktree w VS Code lub Cursor |
| Uruchamianie edytora przez `ProcessRunner` | runner zbiera wyjście i czeka; edytor musi dziedziczyć terminal albo żyć osobno |
