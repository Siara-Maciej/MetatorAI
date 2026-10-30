# ADR-0076: Kontrakt serwowany w czasie działania (SystemMap v2)

- Status: Proposed
- Data: 2026-10-30

## Kontekst
Mapa systemu (ADR-0063) wymaga, żeby kontrakt miał plik specyfikacji (`spec.path`). Prawdziwy backend NestJS nie trzyma OpenAPI w repozytorium. Generuje dokument w czasie działania (`SwaggerModule.setup('docs')` serwuje `/docs-json`), a trzy frontendy pobierają go skryptem `openapi-typescript` i commitują wygenerowane typy.

`system discover` pokazywał to tylko jako dowód, bez kontraktu i bez konsumentów. Mapa miała więc `contracts: []`, a `system impact` i `system analyze` nie widziały, że zmiana w backendzie dotyka frontendów.

## Decyzja
- **SystemMap v2.** `spec` kontraktu to plik (`{ path }`) albo dokument serwowany (`{ served: /docs-json }`). v1 zostaje zamrożona, a migracja v1 → v2 jest tożsamością (v2 tylko dodaje wariant).
- **`system discover`** proponuje serwowany dokument jako kontrakt (`<aplikacja>-api`, `kind: openapi`), a aplikacje, które go pobierają, dostają go w `consumes`.
- **`contract diff`** nie porównuje kontraktu serwowanego. Raportuje go w `notCompared`, nigdy jako `unchanged`: nie ma pliku przy bazie, z którym można by porównać.
- **`system lint`** nie szuka pliku dla kontraktu serwowanego.
- **`system impact`** i **`system analyze`** traktują go jak każdy inny kontrakt. Zmiana w plikach dostawcy oznacza go jako dotknięty (`implementation`), a jego konsumenci są w analizie.

## Konsekwencje
### Pozytywne
- Na prawdziwym backendzie i frontendzie mapa ma kontrakty i konsumentów bez zmian w kodzie aplikacji.
- Plan zmiany systemowej widzi frontendy, które zmiana backendu dotyka.

### Negatywne
- Kontrakt serwowany nie ma porównania wersji. Zmiana łamiąca nie jest wykrywana automatycznie, dopóki zespół nie wyeksportuje dokumentu do pliku. `--breaking` w `system analyze` nadal pozwala ją zadeklarować.
- Starsza wersja MetatorAI nie odczyta mapy v2.

## Implikacje dla kodu
- `specPath` zwraca `undefined` dla kontraktu serwowanego; każde miejsce, które czyta plik specyfikacji, musi to obsłużyć.
