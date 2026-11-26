# ADR-0112: Martwy kod tego repozytorium: knip w `bun run check`

- Status: Accepted
- Data: 2026-11-25

## Kontekst
Repozytorium ma ok. 930 plików TypeScript w 20 pakietach. Biome i `tsc` widzą nieużywaną zmienną w pliku, ale nie widzą eksportu, którego nikt nie importuje, pliku, do którego nic nie prowadzi, ani zależności w `package.json`, której kod nie używa. Pierwszy przebieg knip (2026-11-25) znalazł 75 martwych eksportów, 50 martwych eksportów typów i jedną zbędną zależność (`@types/shell-quote`: `shell-quote` 1.12 ma własne typy).

ADR-0063 odrzucił knip jako **adapter produktu** (`arch` liczy martwe eksporty z własnego indeksu oxc, bo drugi parser i resolver w produkcie nic nie wnoszą). Ta decyzja zostaje. Tu chodzi o narzędzie deweloperskie tego repozytorium, tak jak Biome i ast-grep w CI.

## Decyzja
1. **knip jako devDependency korzenia**, konfiguracja w `knip.jsonc`, komenda `bun run knip`, krok w `bun run check` i w CI.
2. **Pakiety są prywatne, więc eksport z `index.ts`, którego nie importuje żaden inny pakiet, też jest martwy** (`includeEntryExports`). Wyjątek: `packages/cli/src/index.ts` (wejście dla programu osadzającego CLI).
3. **Wyjątki są jawne i opisane w `knip.jsonc`**: pliki uruchamiane jako osobny proces (wejścia), zależności rozwiązywane w czasie działania (`@anthropic-ai/sandbox-runtime`, binarki `@ast-grep/cli` i `@biomejs/biome`), motyw VitePressa (importowany z plików `.vue`, których knip nie czyta). Eksport importowany tylko przez wygenerowany kod ma znacznik JSDoc `@public` z powodem (`nativeAddon`).
4. Zero znalezisk jest warunkiem zielonego `check`; nowego wyjątku nie dodaje się po to, żeby kod przeszedł, tylko gdy użycie jest prawdziwe, a knip go nie widzi.

## Konsekwencje
### Pozytywne
- Martwy eksport, plik i zależność wychodzą w PR, w którym powstały.
- Mniejsza powierzchnia publiczna pakietów: karty modułów i `api snapshot` pokazują to, co naprawdę jest używane.

### Negatywne
- Kolejne narzędzie w `check` (kilka sekund) i konfiguracja wyjątków do utrzymania.
- Użycie przez tekst (kod generowany, mutanty) knip nie widzi; takie miejsca wymagają znacznika albo wpisu w konfiguracji.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| `metator arch` (martwe eksporty z ADR-0063) | liczy eksporty pakietów na granicach, nie pliki bez wejścia ani zależności w `package.json` |
| `tsc --noUnusedLocals` | widzi tylko symbole lokalne pliku |
| `ts-prune`, `unimported` | nieutrzymywane; autorzy odsyłają do knip |

## Implikacje dla kodu
ADR-0112 egzekwuje reguła kanonu MT-CODE-010 (`metator rules show MT-CODE-010`): test zgodności `rules/conformance/mt-code-010.test.ts` uruchamia knip.
- `knip.jsonc`, skrypt `knip` i `check` w `package.json`, krok w `.github/workflows/ci.yml`.
- Rejestr zależności: `knip`.
