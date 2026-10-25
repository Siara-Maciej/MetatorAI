# ADR-0004: Konfiguracja: metator.config.ts / .json, warstwy, jeden schemat

- Status: Proposed
- Data: 2026-10-25
- Źródło: [ARCHITECTURE.md §8](../ARCHITECTURE.md)

## Kontekst
Konfiguracja musi być typowana dla repo TS i dostępna dla repo bez TS. Agent bootstrappera też musi ją rozumieć.

## Decyzja
`metator.config.ts` (`defineConfig`) albo `metator.config.json` z `$schema`. Jeden schemat (zod) generuje typ TS, walidację i JSON Schema. Kolejność ważności: flagi CLI > env (`METATOR_*`) > plik konfiguracji > wynik discovery > presety pluginów > defaulty.

## Konsekwencje
### Pozytywne
- Jedno źródło prawdy dla typu, walidacji i dokumentacji (DRY).

### Negatywne
- Ładowanie `.ts` na Node wymaga type-stripping albo loadera.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Tylko YAML | brak typów i autouzupełniania w edytorze |
