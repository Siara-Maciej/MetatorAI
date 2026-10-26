# ADR-0029: `metator.config`, `init` i bramki `gate quick|full`

- Status: Proposed
- Data: 2026-10-26

## Kontekst
ADR-0004 przewiduje jeden plik konfiguracji z warstwami nad wartościami domyślnymi. Bramki ([commands](../design/04-commands.md)) mają uruchamiać sprawdzenia projektu jedną ścieżką: skrypty `package.json` przez package manager repo, binarki z `node_modules/.bin`, sprawdzenia MetatorAI w procesie. Discovery (ADR-0028) dostarcza faktów, z których da się zaproponować konfigurację bez zgadywania.

## Decyzja
- **`metator.config.yml` / `.yaml` / `.json`** to wersjonowany dokument `MetatorConfig` v1 (ADR-0016) z sekcjami `paths`, `project` (`sourceIgnores`, `testGlobs`) i `gates`. Jest wczytywany raz w composition root (`loadConfig`), a ścieżki z konfiguracji nadpisują domyślne. Niepoprawna konfiguracja zatrzymuje każdą komendę z dokładną ścieżką pola. Wariant `.ts` (`defineConfig`) jest odłożony.
- **Krok bramki:** `run` to `{script}` (przez port `PackageManager`), `{bin, args}` (przez nowy port `BinResolver`: najpierw binarka repo, potem PATH, nigdy pobieranie) albo `{metator: "rules check"}`. Dalej: `files: append|none`, `match` (globy plików, które krok przyjmuje), `okExitCodes`, `timeoutMs`.
- **`metator gate quick|full [--files|--base]`** uruchamia wszystkie kroki (bez przerywania po pierwszym błędzie):
  - usunięte pliki są pomijane;
  - krok bez pasujących plików jest `skipped`;
  - nieudany krok dostaje końcówkę wyjścia (≤ 20 linii);
  - kod 127 to `error`;
  - raport to wersjonowany `GateReport` w `.metator/gates/<gate>.json`.
- **`metator init [--dry-run]`:** discovery, a potem deterministyczna propozycja z decyzjami i dowodami (`proposeConfig`):
  - skrypty `lint`/`typecheck`/`test`/`e2e` trafiają do `full`;
  - `lint` w `quick` idzie po plikach, jeśli skrypt jest `fileScopable`; inaczej przez Biome albo ESLint po plikach, gdy narzędzie jest wykryte;
  - kanon reguł dodaje `rules check`;
  - zapisywane są tylko wartości różne od domyślnych, a istniejący plik nie jest nigdy nadpisywany.
- Dogfood: `metator.config.yml` MetatorAI (`quick`: Biome po plikach, reguły, typecheck; `full`: skrypty CI).

## Konsekwencje
### Pozytywne
- Ta sama komenda dla człowieka, hooka i CI; agent może wołać `gate quick --base` przed oddaniem pracy.
- Konfiguracja nowego repo zaczyna się od propozycji z dowodami, nie od pustego pliku.
### Negatywne
- Kroki są wykonywane sekwencyjnie; równoległość i `test affected` dojdą w F4.
- Warstwa env (`METATOR_*`) poza `METATOR_NOW` jeszcze nie istnieje.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| `npx`/`bunx` dla binarek | mogą pobierać pakiety z sieci; binarka repo jest przypięta i szybsza |
| Przerywanie bramki na pierwszym błędzie | jeden przebieg ma pokazać wszystko, co jest czerwone |
| Tylko `metator.config.ts` | wymaga wykonania kodu przy każdym uruchomieniu; YAML/JSON wystarczają na v1 |
