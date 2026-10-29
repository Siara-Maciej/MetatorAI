# ADR-0056: Niezależne repozytoria na jednej maszynie

- Status: Accepted
- Data: 2026-10-27

## Kontekst
Użytkownik chce mieć kilka repozytoriów, każde z własnym, niezależnym Metatorem, na jednej maszynie. Konfiguracja, kanon, runy, worktree i stan środowiska są już per repozytorium. Weryfikacja ([design/10 §2](../design/10-repos-ask-tui.md)) znalazła jednak dwie kolizje:
- bloki portów worktree są dzierżawione w rejestrze danego repozytorium (`.metator/worktrees.json`), więc dwa repozytoria mogą dostać ten sam blok;
- projekt Docker Compose nazywa się `metator-<miejsce>` w każdym repozytorium, więc kontenery dwóch repozytoriów się nadpisują.

## Decyzja
- **Stan całej maszyny (port `MachineState`):**
  - małe dokumenty JSON w katalogu użytkownika: `$METATOR_STATE_DIR`, potem `$XDG_STATE_HOME/metator`, potem `~/.local/state/metator`;
  - adapter `BunMachineState` zapisuje atomowo (plik tymczasowy, potem `rename`);
  - katalog wybiera runtime (`machineStateDir`), a CLI podaje go ze swojego środowiska.
- **`PortLeases` v1** (`port-leases.json`):
  - każdy wpis to repozytorium, worktree, ścieżka worktree, blok portów i czas;
  - `worktree new` omija bloki trzymane przez dowolne repozytorium, a `worktree rm` zwalnia blok;
  - dzierżawa, której katalog worktree zniknął, nic nie trzyma i znika przy następnym zapisie, więc usunięte repozytorium nie blokuje portów.
- **Projekt Compose per repozytorium i miejsce:** `metator-<slug katalogu>-<6 znaków FNV-1a ścieżki>-<miejsce>`, np. `metator-shop-1a2b3c-shared`.
- Testy e2e dostają własny katalog stanu (`METATOR_STATE_DIR` w helperach), więc nie dotykają stanu użytkownika.

## Konsekwencje
### Pozytywne
- e2e: dwa prawdziwe repozytoria na jednej maszynie dostają rozłączne bloki portów i różne projekty Compose. Blok zwolniony w jednym repozytorium może wziąć drugie.
- Nic nie jest współdzielone między repozytoriami poza tym jednym rejestrem dzierżaw.
### Negatywne
- Dwa procesy tworzące worktree w tej samej chwili mogą odczytać tę samą listę dzierżaw. Ryzyko jest małe, bo `PortProbe` dodatkowo sprawdza, czy porty są wolne; blokady pliku można dodać, gdy będzie potrzebna.
- Usługi `shared`, które w kilku repozytoriach deklarują ten sam stały port (np. 5432), nadal ze sobą konkurują. To konfiguracja człowieka: dokumentacja każe nadać im różne porty.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Stałe zakresy portów per repozytorium (hash ścieżki) | kolizje hashy i marnowanie zakresu; rejestr jest dokładny |
| Demon trzymający dzierżawy | nowy proces do utrzymania, a plik wystarcza |
| Nazwa projektu Compose z nazwy katalogu | dwa repozytoria o tej samej nazwie w różnych miejscach i tak by się zderzyły |

## Implikacje dla kodu
ADR-0056 egzekwują reguły kanonu MT-ARCH-007, MT-TEST-001 (`metator rules show <id>`).
