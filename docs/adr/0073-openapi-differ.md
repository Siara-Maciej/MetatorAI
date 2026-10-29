# ADR-0073: Differ OpenAPI na `api-smart-diff`: parametry, OpenAPI 3.1 i Swagger 2 przez konwersję

- Status: Proposed
- Data: 2026-10-29

## Kontekst
ADR-0069 oparł `contract diff` na `openapi-diff`. Ten pakiet nie klasyfikuje zmian parametrów i nie obsługuje OpenAPI 3.1. Nie zauważy więc ani parametru, który stał się wymagany, ani nowego wymaganego nagłówka, ani usuniętego parametru zapytania. Właściciel uznał to za brak: `contract diff` ma takie zmiany wykrywać. `openapi-diff` waży przy tym 22 MB zależności (swagger-parser, axios, lodash).

## Decyzja
- **`api-smart-diff` (1.x)** porównuje OpenAPI 3.0 i 3.1. Klasyfikuje:
  - operacje;
  - parametry: dodane, usunięte, wymagane;
  - ciała żądań i odpowiedzi, z rozwiązaniem `$ref` wewnątrz dokumentu.

  Ma dwie zależności.
- **Swagger 2** jest najpierw konwertowany do OpenAPI 3 przez `swagger2openapi`, bez rozwiązywania zewnętrznych `$ref`, a potem porównywany tak samo.
- **Liczy się tylko powierzchnia API:** `paths`, `webhooks`, `security`, `servers`. Zmiany w `components` są widoczne tam, gdzie używa ich operacja (przez `$ref`), więc ich własne wpisy liczyłyby zmianę dwa razy. `info`, `tags` i opisy nie są API.
- **Własna korekta typów.** `api-smart-diff` uznaje każdą zmianę `type` za niełamiącą. Według differa zmiana typu jest łamiąca, jeśli:
  - w żądaniu zawęża to, co konsument wysyła (wyjątek: `integer` → `number`);
  - w odpowiedzi poszerza to, co konsument dostaje (wyjątek: `number` → `integer`).
- **Kontrola wejścia.** Biblioteka nie waliduje dokumentów, więc differ sprawdza sam:
  - wersję: `openapi: 3.x` albo `swagger: "2.0"`;
  - że `paths` jest obiektem.

  Wszystko inne to `PARSE_FAILED`, nigdy wyjątek.
- **Kody zmian** mają postać `<podmiot>.<akcja>`: `operation.remove`, `parameter.add`, `response.replace`. Obie biblioteki są ładowane przy pierwszym porównaniu, więc start CLI ich nie płaci.
- **Zależności:** `openapi-diff` zostaje usunięty.
  - `api-smart-diff` i `swagger2openapi` trafiają do `plugin-openapi`;
  - `@types/swagger2openapi` jest dev-zależnością.

  ADR-0069 obowiązuje dalej co do werdyktu, polityki i bramki. Zmienia się tylko silnik porównania.

## Konsekwencje
### Pozytywne
- Wykrywane są teraz:
  - parametr, który stał się wymagany;
  - nowy wymagany parametr;
  - usunięty parametr;
  - pole odpowiedzi, które przestało być wymagane (także przez `$ref`);
  - zawężony typ w żądaniu;
  - OpenAPI 3.1.
- Zależności zajmują 6,9 MB zamiast 22 MB.
- Testy adaptera i zestaw kontraktowy `contractDifferContract` obejmują każdy z tych przypadków. e2e na prawdziwym CLI pokazuje kod `operation.add`.
### Negatywne
- Korekta typów jest heurystyką na poziomie `type`, bez analizy `format`, `enum` ani `oneOf`. Takie zmiany zostają w klasyfikacji biblioteki.
- Zewnętrzne `$ref` (inne pliki, URL-e) nie są rozwiązywane. Zmiana w takim pliku nie jest widoczna, dopóki specyfikacja nie jest złożona w jeden dokument.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Zostać przy `openapi-diff` i dopisać własne porównanie parametrów | dwa silniki i własna logika dla tego, co gotowy pakiet już robi (ADR-0010) |
| `oasdiff` (Go) | najpełniejsze reguły, ale binarka spoza npm na każdej maszynie i w CI |
| Zostawić Swagger 2 bez porównania (`unclassified`) | `system discover` rozpoznaje Swagger 2, a konwersja to gotowy, standardowy pakiet |
