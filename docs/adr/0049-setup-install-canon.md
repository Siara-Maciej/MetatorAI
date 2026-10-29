# ADR-0049: `metator setup` i instalacja kanonu z pakietu (`InstallLock`)

- Status: Accepted
- Data: 2026-10-27

## Kontekst
Instalacja MetatorAI w repo wymagała ręcznego kopiowania kanonu (`cp -r …/metator`, `cp -r …/.github/metator/workflows`) i osobnych komend `init` oraz `generate`. Nie było wyboru hosta ani bezpiecznej aktualizacji: ponowne kopiowanie nadpisywało zmiany zespołu w agentach i skillach. Plan i decyzje: [design/09 §3.1 i §8](../design/09-workspaces-sessions.md) (F8.1).

## Decyzja
- **Kanon jest zasobem instalacji MetatorAI.** `runtime` wskazuje katalog z `metator/agents`, `metator/skills` i `.github/metator/workflows` w katalogu własnej instalacji. `METATOR_CANON` nadpisuje to miejsce (testy, kanon organizacji). Brak kanonu to `NOT_FOUND` z podpowiedzią.
- **`agents install|update`** (przypadek użycia `InstallCanon`) kopiuje agentów i skille w całości oraz wybrane workflowy, pod ścieżki z configu repo. Decyzja per plik jest czystą funkcją `planInstall`:

  | Stan | Akcja |
  |------|-------|
  | brak pliku | `create` |
  | ta sama treść | `unchanged` |
  | plik bez zmian od ostatniej instalacji, kanon nowszy | `update` |
  | plik zmieniony lokalnie, kanon bez zmian | `kept` (także z `--theirs`) |
  | zmiany po obu stronach albo plik bez wpisu w locku | `conflict` (zostaje lokalny, ostrzeżenie); z `--theirs` `overwrite` |

  Pliki, których kanon już nie ma, są tylko raportowane (`removedUpstream`), nigdy usuwane.
- **`InstallLock` v1** (`metator/install.lock.json`) zapisuje wersję MetatorAI, wybrane workflowy i SHA-256 każdego zapisanego pliku. Hash liczy Web Crypto (`crypto.subtle`): standard dostępny w Bun, Node i przeglądarkach, bez zależności i bez I/O w `core`. Konflikt zachowuje w locku stary hash, więc zostaje konfliktem przy kolejnej aktualizacji, dopóki ktoś go nie rozstrzygnie.
- **`setup`** składa istniejące kroki przez `invoke`, każdy w świeżym kontenerze, więc nowy config działa od razu:
  1. `init --host …`, tylko gdy configu nie ma; inaczej ostrzeżenie, jeśli wybrane hosty różnią się od `hosts.targets`;
  2. `agents install`, albo `update`, gdy lock istnieje;
  3. `generate [--hooks]`;
  4. `meta agents-lint`, `meta skills-lint`, `workflow lint` i `generate --check` jako dowód gotowości. Pełne `meta check-all` wymaga warstwy wiedzy (mapa pamięci, reguły), której świeże repo jeszcze nie ma.
- **Kreator w terminalu** na `@clack/prompts` (MIT): hosty, workflowy, hooki. Uruchamia się tylko przy TTY na stdin i stderr, bez `--yes` i bez `--host`/`--workflows`. Pytania idą na stderr, więc stdout dalej niesie jedną kopertę JSON. Anulowanie to `USAGE` i nic nie jest zapisane. Komendy wołane przez `invoke` nigdy nie pytają.
- `init --host <hosts...>` zapisuje `hosts.targets`. Agenci wskazują format artefaktu przez `metator run schema <artifact>`, nie przez pliki dostępne tylko w repo MetatorAI.
- e2e kreatora działa w prawdziwym pseudo-terminalu (`Bun.Terminal`, helper `e2e/helpers/terminal.ts`): krok czeka na tekst na ekranie, potem wysyła klawisze.

## Konsekwencje
### Pozytywne
- Jedna komenda od pustego repo do gotowych agentów dla wybranych hostów; aktualizacja kanonu nie cofa pracy zespołu.
- Lock pokazuje w review, która wersja MetatorAI zainstalowała które pliki.
### Negatywne
- Bit wykonywalności skryptów skilli nie jest kopiowany (port `FileSystem` zapisuje tekst); skille wołają skrypty przez `sh`.
- Wybór edytora z kreatora (decyzja 6) przychodzi z F8.6, gdy config dostanie pole `editor`.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| `metator agents --gen` | dubluje `generate`; instalacja i generowanie to dwa kroki z różnymi wejściami |
| Kopia kanonu jako bazy do 3-way merge | duplikuje kanon w repo; hash w locku wystarcza, by odróżnić „nietknięty” od „zmieniony” |
| `@inquirer/prompts` | większy; clack daje te same typy pytań i wyjście na dowolny strumień |
| Pakiet hashujący albo `node:crypto` w `core` | `core` nie robi I/O ani nie zależy od runtime'u; Web Crypto jest standardem |

## Implikacje dla kodu
ADR-0049 egzekwują reguły kanonu MT-CODE-002, MT-CODE-005 (`metator rules show <id>`).
