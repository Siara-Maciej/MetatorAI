# ADR-0022: Karty modułów: generowany blok z grafu, sekcje kuratorowane

- Status: Proposed
- Data: 2026-10-26

## Kontekst
Agent zaczynający pracę w pakiecie potrzebuje krótkiej, prawdziwej wizytówki: od czego pakiet zależy, kto go używa, co jest jego publiczną powierzchnią, jakie ma niezmienniki i pułapki. Fakty strukturalne da się wyliczyć z indeksu, wiedzy (odpowiedzialność, niezmienniki) nie. Ręcznie utrzymywane fakty się rozjeżdżają, a generowanie całego pliku niszczy wiedzę ludzi ([szablon §7](../design/05-templates.md#7-karta-modułu)).

## Decyzja
- **Dokument** `ModuleCard` (Markdown z front matter `kind`, `schemaVersion`, `package`, `dir`; ADR-0016) w `docs/metator/modules/<slug>.card.md`, jeden na pakiet workspace.
- **Blok generowany** między `<!-- metator:generated:start -->` i `<!-- metator:generated:end -->` zawiera wyłącznie fakty strukturalne z grafu importów (ADR-0017):
  - katalog;
  - zależności produkcyjne i osobno zależności tylko testowe;
  - pakiety używające tego pakietu (bez testów);
  - pliki importowane przez inne pakiety, czyli efektywna powierzchnia publiczna;
  - biblioteki zewnętrzne (bez builtinów i bibliotek testowych).

  Bez liczników plików i importów: blok zmienia się tylko przy zmianie architektury, więc `cards build --check` w CI nie jest szumem.
- **Sekcje kuratorowane** (Responsibility, Invariants z cytatami `[[cite: …]]`, Allowed dependencies, Pitfalls) pisze człowiek. Nowa karta dostaje szkielet, a istniejąca zachowuje wszystko poza blokiem.
- Karta z uszkodzonym nagłówkiem lub znacznikami jest zgłaszana jako `invalid` i nigdy nie jest nadpisywana. Karta pakietu, którego już nie ma, to `orphaned` (ostrzeżenie).
- Karty są pozycją `canon` mapy pamięci (ADR-0021): ich cytaty waliduje `memory validate`, a budżet to 60 linii.

## Konsekwencje
### Pozytywne
- Fakty w kartach są zawsze prawdziwe (CI), a wiedza ludzi jest chroniona przed regeneracją.
- Zmiana granic pakietów jest widoczna w diffie karty, czyli w review.
### Negatywne
- Publiczne API na poziomie symboli (`api snapshot`) i wzorce dojdą później; na razie powierzchnia jest liczona na poziomie plików.
- CODEOWNERS (właściciel) nie jest jeszcze czytany.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Osobne pliki: generowany i kuratorowany | agent musi czytać dwa pliki, łatwo zgubić jeden |
| Liczniki plików i importów w bloku | każdy PR dodający plik musiałby regenerować karty |
| Generowanie całej karty | niszczy kuratorowaną wiedzę |
