# ADR-0040: Symbole i API: `symbols find`, `graph callers`, `api snapshot|diff`

- Status: Accepted
- Data: 2026-10-26

## Kontekst
Graf importów działa na poziomie plików. Plan, review i refactor pytają o symbole: gdzie jest zdefiniowana nazwa, kto jej używa i czy zmiana dotknęła publicznego API pakietu (W3: „api diff = brak zmian”). 04-commands §A wymienia te komendy jako P0.

## Decyzja
- **Port `SymbolAnalyzer`** (`symbols(path, content)`), oddzielony od `ImportAnalyzer` (inna oś). Implementuje go `OxcImportAnalyzer` na tym samym rekordzie modułu oxc: eksporty z linią i `typeOnly`, re-eksporty z nazwą importowaną i eksportowaną (`*` dla gwiazdki), importy z nazwą lokalną.
- **Domena:**
  - `findSymbol`: definicje, czyli tylko lokalne eksporty;
  - `callersOf`: dostawcy nazwy liczeni punktem stałym po re-eksportach (beczki, zmiany nazw, `export *` bez `default`; `export * as ns` nie re-eksportuje samej nazwy). Wołający to importy tej nazwy od dowolnego dostawcy oraz importy namespace dostawcy.
- **`symbols find <name>`** zwraca definicje i moduły, które je re-eksportują. **`graph callers <symbol> [--file]`** zwraca wołających; nazwa eksportowana przez kilka plików wymaga `--file`.
- **Port `DeclarationEmitter`** (`TscDeclarationEmitter`): `tsc --declaration --emitDeclarationOnly` do katalogu tymczasowego. Błędy typów nie blokują deklaracji.
- **`api snapshot <package>`:** pliki `.d.ts` osiągalne z wejścia pakietu (`exports["."]` z warunkami `import|default|…`, albo `main`) przez `export … from`. Linie są znormalizowane: bez komentarzy, bez członków `private` i `#`, bez układu. Wynik to wersjonowany `ApiSnapshot` w `.metator/api/<pakiet>.json`.
- **`api diff <package>`:** linie dodane i usunięte per plik, liczone jako multizbiory (przeniesienie linii nie jest zmianą). Każda zmiana daje `CHECK_FAILED`.

## Konsekwencje
### Pozytywne
- Refactor ma twardy dowód braku zmiany API; plan i review mają wołających nazwy, także przez `@scope/pkg`.
- Gotowe narzędzia: oxc dla nazw, tsc dla deklaracji; MetatorAI dokłada tylko przechodzenie re-eksportów i normalizację.
### Negatywne
- `symbols find` parsuje wszystkie pliki źródłowe przy każdym wywołaniu (bez indeksu nazw).
- API obejmuje całe pliki deklaracji osiągalne z wejścia, także eksporty, których wejście nie re-eksportuje nazwą.
- Snapshot zależy od wersji tsc (inna wersja może inaczej sformatować deklaracje).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| API Extractor (`@microsoft/api-extractor`) | ciężki, wymaga własnej konfiguracji i build-u `.d.ts`; TS 7 bez klasycznego API (ADR-0008) |
| Diff tekstowy plików `.d.ts` | zmiana komentarza lub kolejności to fałszywy alarm |
| Wołający przez wyszukiwanie tekstowe | nie widzi beczek i zmian nazw, łapie przypadkowe zbieżności |

## Implikacje dla kodu
ADR-0040 egzekwują reguły kanonu MT-ARCH-008, MT-TEST-001 (`metator rules show <id>`).
