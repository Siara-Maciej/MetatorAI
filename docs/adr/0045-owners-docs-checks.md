# ADR-0045: `owners`, `docs inventory|links|drift`, właściciele i wzorce w kartach

- Status: Proposed
- Data: 2026-10-26

## Kontekst
Scout i PR author potrzebują właściciela ścieżki do eskalacji i review (04-commands §4, P2). W7 (`mt-docs-curator`) potrzebuje:
- inwentarza dokumentów;
- listy martwych linków;
- ponownego sprawdzania twierdzeń, które raz zweryfikował (nightly W10: `docs drift`).

Karty modułów nie mówiły, kto jest właścicielem pakietu ani jakie wzorce mają w nim exemplar.

## Decyzja
- **CODEOWNERS** czytamy tam, gdzie szuka GitHub: `.github/`, korzeń repo, `docs/`. Każdy wzorzec zamieniamy na globy picomatch (biblioteka już zatwierdzona w core) według reguł GitHuba:
  - bez ukośnika wzorzec pasuje na każdej głębokości;
  - wiodący albo środkowy ukośnik kotwiczy wzorzec w korzeniu;
  - `dir/` obejmuje całą zawartość katalogu;
  - `dir/*` obejmuje tylko pliki bezpośrednio w katalogu;
  - decyduje ostatnia pasująca linia; linia bez właścicieli zostawia ścieżkę bez właściciela.

  Nagłówki sekcji GitLaba są pomijane. Testy używają przykładów z dokumentacji GitHuba.
- **`owners <paths…>`** zwraca właścicieli i decydującą linię. **`docs inventory`** zwraca każdy dokument Markdown z liczbą linii, datą ostatniego commita (`RevisionReader.lastChanged`, jedno `git log` dla repo), wiekiem, właścicielami i linkami.
- **`docs links`** sprawdza linki względne w Markdown:
  - zasięg: linki inline, obrazy i definicje referencji, poza kodem (to samo maskowanie co przy cytatach);
  - cel musi być istniejącym plikiem albo katalogiem;
  - `#kotwica` do Markdown musi wskazywać nagłówek wygenerowany przez github-slugger;
  - kotwice do kodu (`#L3`) nie są sprawdzane.
- **`docs drift`** ponownie sprawdza dowody twierdzeń `verified` z `docs/metator/claims.json` (`ClaimSet` v1). Używa tego samego `locateQuote` co cytaty. Wyniki:
  - moved (z prawdziwą linią, poprawiany przez `--fix`);
  - stale albo missing-file, czyli drift.

  Brak pliku oznacza, że nie ma czego sprawdzać. Dzięki temu `meta check-all` uruchamia `docs links` i `docs drift` w każdym repo.
- **Karty** dostają dwie linie w części generowanej:
  - właścicieli pakietu z CODEOWNERS;
  - wzorce z katalogu, których exemplar leży w pakiecie.

  Wzorce bierzemy z katalogu (kanon), nie z indeksu w `.metator`: świeży klon w CI musi dać tę samą kartę. API na poziomie symboli zostaje w `api snapshot` i `graph callers`. Lista eksportów w karcie zmieniałaby kartę przy każdym nowym eksporcie, a karta ma opisywać strukturę.

## Konsekwencje
### Pozytywne
- Scout podaje właściciela każdego pliku wejściowego; karty mówią, do kogo eskalować.
- Twierdzenia z dokumentacji są sprawdzane przy każdym `bun run canon`, nie tylko raz.
### Negatywne
- Składnia CODEOWNERS innych hostów (sekcje GitLaba z domyślnymi właścicielami, Azure DevOps) jest obsłużona tylko w części wspólnej z GitHubem.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Pakiet `ignore` (semantyka gitignore) | `docs/*` w gitignore obejmuje też pliki zagnieżdżone, a w CODEOWNERS nie; nowa zależność dla błędnej semantyki |
| `codeowners-utils` | nieutrzymywany od 2022, ciągnie `find-up` i `cross-spawn`; to samo dopasowanie gitignore |
| remark/mdast do linków | ciężka zależność dla trzech form linku; maskowanie kodu już mamy |
