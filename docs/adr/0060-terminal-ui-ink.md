# ADR-0060: Pełnoekranowy `metator ui` na Ink

- Status: Proposed
- Data: 2026-10-28

## Kontekst
`metator ui` z F8.6 (ADR-0054) to menu na `@clack/prompts`. Weryfikacja ([design/10 §2](../design/10-repos-ask-tui.md)) pokazała, że nie wystarcza ono do zarządzania pracą:
- nie widać postępu etapów, kontekstu pytań, hosta, czasu ani portów naraz;
- lista się nie odświeża;
- nie ma ustawień ani pytań do kodu;
- w folderze repozytoriów trzeba było wybierać repozytorium po repozytorium.

Użytkownik chciał interfejsu „enterprise”, jak w Claude Code czy Copilot CLI, ale zaprojektowanego jako własne rozwiązanie. Wszystko miało być ustawiane z poziomu UI.

## Decyzja
- **Biblioteka:**
  - **Ink 8 z React 19.3** (ADR-0010); używają go Claude Code, Copilot CLI i Gemini CLI;
  - **`@inkjs/ui`** daje pole tekstowe, select, multiselect i spinner;
  - **`ink-testing-library`** służy do testów komponentów;
  - wszystko sprawdzone pod Bun 1.4 spike'iem przed decyzją.
  
  `@clack/prompts` zostaje dla `metator setup` i kreatora `metator run`.
- **Ekran** (alternatywny bufor terminala; po wyjściu terminal wraca, jaki był):
  - **nagłówek:** nazwa repozytorium albo folderu oraz liczniki „need you, driving, stopped, services”;
  - **lewy panel:** sesje pogrupowane po repozytorium i posortowane według `WorkOverview` (najpierw te, które czekają na człowieka), a pod nimi rozmowy;
  - **prawy panel dla runu:**
    - zadanie, id, workflow, autonomia, host i czas;
    - co run potrzebuje teraz i jakim klawiszem;
    - pasek etapów (`plan ✓ ─ [plan-approval ?] ─ build ·`);
    - zakładki Overview (pytania, ostatnia aktywność, worktree i porty), Activity (na żywo) i Apps (usługi worktree: start, stop);
  - **prawy panel dla rozmowy:** pytania i odpowiedzi; cytat nieistniejącego pliku jest oznaczony.
- **Działania:**
  - Klawisze:
    - `a` odpowiada na pytanie, a na bramce bez drive'a zatwierdza lub odrzuca ją z powodem;
    - `⏎` wykonuje to, czego sesja potrzebuje;
    - `c` i `x` kontynuują i zatrzymują drive;
    - `n` zakłada nowy run (repozytorium, workflow, zadanie, autonomia, host, worktree);
    - `?` i `r` to nowe pytanie do kodu i dopytanie;
    - `u` i `w` uruchamiają i zatrzymują aplikacje;
    - `e`, `t` i `d` otwierają edytor, powłokę i diff;
    - `,` otwiera ustawienia (edytor, hosty AI), `g` przechodzi do następnej sesji, która czeka, `q` kończy pracę.
  - **Paleta komend** (`:` albo Ctrl+K) daje każdą akcję z nazwy, z filtrem.
- **Odpowiedź wykonuje drive:** po odpowiedzi w UI, gdy żaden drive nie żyje, UI startuje go z hostem, który prowadził run ostatnio (z `driver.json`, potem z `RunRecord`, potem domyślnym).
- **Host domyślny** nowych runów i pytań to `$METATOR_HOST`, jeśli wskazuje znany host; w przeciwnym razie pierwszy z `hosts.targets`.
- **Ustawienia:** `UpdateConfig` (zastępuje `SetEditor`):
  - zmienia `editor` i `hosts.targets`, w YAML z zachowaniem komentarzy (`updateYamlFields` z kluczami z kropką);
  - wynik waliduje przed zapisem;
  - po zmianie hostów UI podpowiada `metator agents update`.
- **Programy na całym terminalu:** edytor terminalowy, powłoka i `git diff` dostają terminal. Ink się wyłącza, a po ich zakończeniu wraca z tym samym zaznaczeniem i zakładką. Edytor okienkowy startuje odłączony.
- **Architektura:**
  - widok (`tui/App.tsx` i komponenty) zna tylko interfejs `TuiService`;
  - implementacja (`tui/service.ts`) działa na kontenerach repozytoriów (`containerAt`), a model (`tui/model.ts`) to czyste funkcje;
  - ekran idzie na stderr, bo stdout niesie tylko kopertę JSON (MT-CODE-004);
  - bez terminala jest `USAGE` z odsyłaczem do `metator status`.
- Hub z F8.6 (`src/ui.ts`) usunięty. ADR-0054 zostaje dla edytora w konfiguracji i portu `Launcher`, a jego menu zastępuje ta decyzja.

## Konsekwencje
### Pozytywne
- Jeden ekran do całej pracy z wieloma runami i repozytoriami; każda akcja jest też komendą CLI, a każdy widok wynika z `metator status`.
- Testy:
  - 10 testów komponentów z prawdziwymi klawiszami: odpowiedź, `Other` ze słowami, bramka, pytanie z odpowiedzią na żywo, paleta, nowy run, ustawienia, oddanie terminala, dzwonek;
  - e2e w pseudo-terminalu: bramka, wybór edytora w ustawieniach i otwarcie worktree, start aplikacji, pytanie do kodu, wyjście z kopertą oraz folder dwóch repozytoriów na jednym ekranie.
### Negatywne
- Odświeżanie przez odpytywanie co sekundę (`METATOR_UI_REFRESH_MS`). Przy wielu repozytoriach trzeba będzie przejść na obserwowanie plików.
- Długie rozmowy pokazują ostatnie tury; pełna historia jest w `metator ask list` i pliku rozmowy.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| OpenTUI (`@opentui/core` 0.7) | szybszy i natywny dla Bun, ale to wersja 0.x z wydaniem sprzed 2 dni i warstwą natywną (FFI) |
| blessed / neo-blessed | nierozwijane |
| Rozbudowa menu na `@clack/prompts` | brak układu paneli, odświeżania na żywo i palety |
| Własny renderer | ADR-0010: gotowy pakiet przed własnym kodem |
