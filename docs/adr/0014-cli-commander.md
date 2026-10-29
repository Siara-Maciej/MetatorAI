# ADR-0014: Parser CLI: commander

- Status: Accepted
- Data: 2026-10-25

## Kontekst
CLI `metator` ma podkomendy (`run init|advance|status|list`, `workflow list|validate|schema`, `changed`), opcje wymagane i walidację. Wyjście musi być wyłącznie jedną linią JSON (agenci i hooki), więc parser nie może drukować własnej pomocy ani błędów.

## Decyzja
**commander 15**. `exitOverride()` i `configureOutput()` wyłączają wypisywanie przez commander. Każdy `CommanderError` mapujemy na `MetatorError` `USAGE` (kod wyjścia 64), a pomoc generujemy jako JSON z drzewa komend (`metator help`). Use case'y nie wiedzą o commanderze: akcje tylko tłumaczą opcje na wejście use case'a.

## Konsekwencje
### Pozytywne
- Dojrzały parser: podkomendy, wymagane opcje, nieznane opcje i komendy wykrywane bez naszego kodu.
- Pomoc w JSON budowana z tego samego drzewa komend (DRY).

### Negatywne
- Komunikaty błędów pochodzą od commander (angielskie, z prefiksem `error:`, który zdejmujemy).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| citty | przyjemne API, ale wersja 0.x |
| cac | mniej popularny, podobne możliwości |
| Własny parser argv | duplikuje dojrzałą bibliotekę |

## Implikacje dla kodu
ADR-0014 egzekwują reguły kanonu MT-CODE-004, MT-CODE-005 (`metator rules show <id>`).
