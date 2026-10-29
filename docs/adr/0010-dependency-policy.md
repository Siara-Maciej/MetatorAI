# ADR-0010: Polityka zależności: gotowe biblioteki zamiast własnych

- Status: Accepted
- Data: 2026-10-25

## Kontekst
Pierwsza wersja fundamentu miała własny kontener DI, własny graf, własny `Result` i własny parser globów. To koszt utrzymania, ryzyko błędów i brak sprawdzonych algorytmów (np. cykli, ścieżek) bez realnej wartości dla produktu.

## Decyzja
**Najpierw szukamy gotowego pakietu.** Własny kod piszemy tylko dla logiki specyficznej dla MetatorAI (capabilities, workflowy, reguły, envelope, adaptery). Kryteria wyboru pakietu:

1. Aktywnie utrzymywany (wydanie w ostatnich ~18 miesiącach albo dojrzały i stabilny), licencja MIT, Apache-2.0, ISC lub BSD.
2. Typy TypeScript, ESM lub poprawny interop, działa na Bun i Node, nie wymaga dekoratorów ani `reflect-metadata`.
3. Mało zależności przechodnich. W `core` tylko biblioteki **czyste** (bez I/O), z listy dozwolonych, egzekwowanej regułą ast-grep `mt-arch-core-approved-deps`.
4. Sprawdzone w ekosystemie (popularność, użycie w znanych projektach).
5. Wybór dokumentujemy w ADR, z odrzuconymi alternatywami.

Bieżące wybory:

| Potrzeba | Pakiet | ADR |
|----------|--------|-----|
| DI | awilix | 0011 |
| Graf | @dagrejs/graphlib | 0012 |
| Maszyna stanów | xstate v5 | 0013 |
| Result | neverthrow | ten ADR |
| Glob | picomatch | ten ADR |
| Schematy, walidacja, JSON Schema | zod | 0015 |
| YAML | yaml | 0015 |
| Slug identyfikatorów | @sindresorhus/slugify | 0015 |
| Parser CLI | commander | 0014 |
| Wyszukiwanie strukturalne | ast-grep | 0008 |
| Lint/format | Biome | – |

## Konsekwencje
### Pozytywne
- Mniej własnego kodu do utrzymania, sprawdzone algorytmy.
- Reguła ast-grep blokuje przypadkowe dociąganie zależności do `core`.

### Negatywne
- Zależność od cudzego harmonogramu wydań: przypinamy wersje (`bun.lock`) i aktualizujemy świadomie.
- Cienkie adaptery wokół bibliotek, żeby błędy wracały jako `MetatorError`.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Pisanie własnych implementacji | koszt i ryzyko bez wartości dla produktu |
| Dowolne pakiety bez listy dozwolonych w core | erozja czystości domeny, I/O w rdzeniu |

## Implikacje dla kodu
ADR-0010 egzekwują reguły kanonu MT-CODE-005, MT-ARCH-003 (`metator rules show <id>`).
