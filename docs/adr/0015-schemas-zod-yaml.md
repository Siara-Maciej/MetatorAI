# ADR-0015: Schematy i specyfikacje: zod + yaml

- Status: Proposed
- Data: 2026-10-25

## Kontekst
Specyfikacje workflow (YAML), stan runu (`state.json`) i przyszła konfiguracja muszą być walidowane z dokładnymi ścieżkami błędów, a typy TypeScript i JSON Schema dla agentów nie mogą się rozjechać z walidacją.

## Decyzja
**zod 4** jako jedyne źródło prawdy: schemat → typ (`z.output`/`z.infer`) → walidacja → JSON Schema (`z.toJSONSchema`, komenda `metator workflow schema`). Reguły semantyczne (duplikaty, nieznane etapy, brakujące limity pętli, zarezerwowane nazwy) siedzą w `superRefine` schematu, nie w maszynie stanów. Schematy są `strict`, więc literówki w kluczach są błędem. YAML parsuje **yaml 2** (eemeli). Identyfikatory runów generuje **@sindresorhus/slugify** (transliteracja, np. „łączony” → „laczony”). Wszystkie trzy biblioteki są czyste i dopisane do listy dozwolonych w `core`.

## Konsekwencje
### Pozytywne
- Jeden schemat, zero rozjazdu między typem, walidacją i dokumentacją.
- Błędy ze ścieżkami (`stages.0.onFail.goto`) trafiają do agenta w `error.details`.

### Negatywne
- Typy z `z.output` są mutowalne, a pola opcjonalne mają `| undefined`, co wymaga ostrożności przy `exactOptionalPropertyTypes`.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| JSON Schema + ajv | osobne typy TS, ryzyko rozjazdu |
| valibot | mniejszy, ale słabszy ekosystem i eksport JSON Schema |
| js-yaml | yaml (eemeli) lepiej obsługuje YAML 1.2 i błędy z pozycjami |
