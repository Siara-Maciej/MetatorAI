# ADR-0017: Analiza importów JS/TS: oxc-parser + oxc-resolver

- Status: Proposed
- Data: 2026-10-25
- Zastępuje częściowo: [ADR-0008](0008-typescript-7-graph.md) (ekstrakcja i rozwiązywanie importów)

## Kontekst
Graf importów potrzebuje dwóch rzeczy: listy importów z pliku (statyczne, `import type`, re-eksporty, dynamiczne `import()`) i rozwiązania specyfikatora do pliku w repo (`tsconfig#paths`, `package.json#exports`, symlinki workspace, alias `.js` → `.ts`). ADR-0008 zakładał ast-grep i własny resolver. Własny resolver to dokładnie ten rodzaj generycznej logiki, której ADR-0010 zabrania pisać.

## Decyzja
- **oxc-parser** (`parseSync`, gotowy `module` record: `staticImports`, `staticExports`, `dynamicImports`) do ekstrakcji importów.
- **oxc-resolver** (`ResolverFactory`: `extensionAlias`, `conditionNames`, `tsconfig` z `references: "auto"`) do rozwiązywania, zgodnie z algorytmem Node/bundlera.
- Adapter `OxcImportAnalyzer` w `packages/plugin-typescript` implementuje port `ImportAnalyzer`. Core nie zna oxc.
- Parsowanie jest cache'owane po fingerprincie treści w wersjonowanym dokumencie `ImportIndex` (`.metator/index/imports.json`); rozwiązywanie wykonuje się przy każdym przebiegu (nowy plik może spełnić stary import).

## Konsekwencje
### Pozytywne
- Natywna szybkość (Rust), zgodność rozwiązywania z narzędziami, które użytkownik już ma (Rolldown, Biome-like ekosystem).
- Brak własnego resolvera do utrzymania.
### Negatywne
- Binarne pakiety natywne per platforma (obsługiwane przez npm `optionalDependencies`).
- `require()` w CommonJS nie jest analizowany.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| ast-grep + własny resolver (ADR-0008) | własny resolver `exports`/`paths` to wymyślanie koła na nowo |
| API kompilatora TypeScript | TS 7 (natywny) nie ma stabilnego API JS |
| dependency-cruiser / madge | całe narzędzia CLI z własnym modelem i konfiguracją, za ciężkie jako biblioteka |
| es-module-lexer + enhanced-resolve | lexer nie rozróżnia `import type`; enhanced-resolve wolniejszy i bez natywnego `tsconfig#paths` |
