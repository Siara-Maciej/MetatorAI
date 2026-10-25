# ADR-0012: Graf zależności: @dagrejs/graphlib

- Status: Proposed
- Data: 2026-10-25

## Kontekst
Komendy `graph affected|callers|path|cycles|diff` potrzebują grafu z algorytmami: przejście, cykle, najkrótsze ścieżki, topsort.

## Decyzja
**@dagrejs/graphlib 4** (zero zależności, aktywnie utrzymywany). `DependencyGraph` to cienka klasa domenowa: `affected()` przez `alg.preorder` na grafie odwróconym, `cycles()` przez `alg.findCycles` (Tarjan), `path()` przez `alg.dijkstra`. Nie implementujemy algorytmów grafowych sami.

## Konsekwencje
### Pozytywne
- Sprawdzone algorytmy, szybkie dodawanie nowych zapytań (topsort, komponenty).

### Negatywne
- API graphlib jest imperatywne i oparte na stringach jako węzłach: opakowujemy je w typowane metody domenowe.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| graphology | bogatszy ekosystem, ale podpakiety algorytmów rzadziej wydawane, więcej zależności |
| Własna implementacja | duplikuje dojrzałą bibliotekę, ryzyko błędów w algorytmach |
