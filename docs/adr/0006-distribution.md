# ADR-0006: Dystrybucja: npm, samodzielna binarka, obraz Docker

- Status: Accepted
- Data: 2026-10-25
- Źródło: [ARCHITECTURE.md §12](../ARCHITECTURE.md)

## Kontekst
Użytkownicy mają repo JS/TS, ale też repo bez Node. Hooki potrzebują szybkiego startu.

## Decyzja
Pakiet npm `metator-ai` (devDependency; hooki wołają `node_modules/.bin/metator-guard` bez `npx`), binarka `bun build --compile` per OS, obraz `metator-runner` dla self-hosted CI. Semver dla produktu, `apiVersion` dla pluginów, `kind` + `schemaVersion` w każdym pliku (ADR-0016).

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

## Implikacje dla kodu
ADR-0006 egzekwują reguły kanonu MT-CODE-005 (`metator rules show <id>`).
