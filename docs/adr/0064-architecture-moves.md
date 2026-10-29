# ADR-0064: Ruchy refaktoru jako dane, symulacja i najtańsze cięcie cykli

- Status: Accepted
- Data: 2026-10-29

## Kontekst
Plan refaktoru proponuje ruchy: przenieść pliki, scalić pakiety, wydzielić pakiet, odwrócić zależność. Zanim ktokolwiek zmieni kod, trzeba wiedzieć, co ruch naprawi, a co zepsuje ([design/11 §5.4](../design/11-package-architecture.md)). Ocena nie może być opinią modelu.

## Decyzja
- **`Move`** (zod, część przyszłego `RefactorPlan`):
  - `move { files, to }`: pliki albo globy do istniejącego pakietu;
  - `merge { from, into }`: wszystkie pliki pakietu do innego, a pierwszy znika;
  - `extract { files, package: { name, dir } }`: pliki do nowego, prywatnego pakietu;
  - `invert { from, to }`: `from` przestaje zależeć od `to`, a `to` zależy od `from` (port w `from`, adapter w `to`);
  - `declare { package, dependency, field? }`.
- **Zastosowanie** (`applyMoves`) zmienia tylko fakty, nie pliki:
  - przypisanie plików do pakietów (`placement`), manifesty oraz, przy `invert`, importy (także importy po nazwie bez instalacji);
  - przeniesiony kod zachowuje importy: pakiet, który dostaje pliki, deklaruje używane przez nie pakiety workspace i zależności zewnętrzne (te zadeklarowane wcześniej);
  - po `merge` każdy, kto deklarował scalony pakiet, deklaruje pakiet docelowy;
  - deklaracje dodane w ten sposób są podane w `declared`; brakujące deklaracje przenoszą się razem z plikami i pozostają widoczne.
- **Symulacja** (`simulateMoves`, `arch simulate move|merge|extract|invert`) to ta sama analiza przed ruchem i po nim:
  - `before` i `after` (podsumowania);
  - `fixed` i `added` (id naruszeń);
  - `rewrites`, czyli importy, które zmieniają pakiet docelowy;
  - `declared`;
  - pozostałe cykle.
  
  `checkMoves` odrzuca nieznane pakiety, istniejące nazwy dla nowych pakietów i ruchy, które nie obejmują żadnego pliku (`USAGE`).
- **Najtańsze cięcie** (`cut` każdego cyklu w `ArchitectureReport`, pole istniało od v1):
  - minimalny zbiór krawędzi sprzężenia zwrotnego ważony liczbą importów;
  - dokładnie przez permutacje dla cykli do 7 pakietów;
  - powyżej heurystyka Eadesa–Lina–Smytha (ujścia na koniec, źródła na początek, potem największa różnica wag wyjścia i wejścia);
  - test pokazuje graf, na którym heurystyka daje 10, a dokładny wynik to 6.

## Konsekwencje
### Pozytywne
- Każdą propozycję ruchu, ludzką czy agenta, ocenia liczba z tej samej analizy, która pilnuje CI.
- e2e na prawdziwym monorepo:
  - `invert` usuwa cykl;
  - `move` usuwa import względny i brak deklaracji;
  - `merge` i `extract` działają;
  - nieznany pakiet daje `USAGE`;
  - żaden plik nie jest zmieniony.
### Negatywne
- Symulacja nie widzi zmian w samym kodzie, np. podziału pliku na dwa albo wydzielenia interfejsu. `invert` modeluje to jedną syntetyczną krawędzią.
- Permutacje dla 7 pakietów to 5040 porządków na cykl, co jest szybkie. Cykl większy niż 7 pakietów dostaje cięcie przybliżone.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Symulacja na kopii repozytorium (git worktree + prawdziwy codemod) | wolna i zmienia pliki; to robi dopiero wykonanie planu (H6) |
| Solver ILP dla cięcia | nowa zależność dla grafów, które są małe; dokładne permutacje wystarczają do 7 pakietów |
| Tylko heurystyka | potrafi wskazać droższe cięcie (test), a cykle w praktyce są małe |

## Implikacje dla kodu
ADR-0064 egzekwują reguły kanonu MT-ARCH-001, MT-TEST-003 (`metator rules show <id>`).
