# ADR-0006: Dystrybucja: npm, samodzielna binarka, obraz Docker

- Status: Proposed
- Data: 2026-10-25
- Źródło: [ARCHITECTURE.md §12](../ARCHITECTURE.md)

## Kontekst
Użytkownicy mają repo JS/TS, ale też repo bez Node. Hooki potrzebują szybkiego startu.

## Decyzja
Pakiet npm `metator-ai` (devDependency; hooki wołają `node_modules/.bin/metator-guard` bez `npx`), binarka `bun build --compile` per OS, obraz `metator-runner` dla self-hosted CI. Semver dla produktu, `apiVersion` dla pluginów, `schema_version` dla artefaktów i configu.

## Konsekwencje
### Pozytywne
- Działa w repo bez JS.
- Szybki start hooków.

### Negatywne
- Macierz buildów binarek per OS.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Tylko npm | wyklucza repo bez Node |
