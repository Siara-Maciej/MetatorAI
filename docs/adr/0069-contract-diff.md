# ADR-0069: `contract diff`: zmiana kontraktu oceniana różnicą specyfikacji i polityką mapy

- Status: Accepted
- Data: 2026-10-29

## Kontekst
`system impact` (ADR-0068) mówi, które kontrakty zmiana dotyka i kto je konsumuje, ale nie mówi, czy zmiana łamie zgodność. Mapa systemu (ADR-0047) ma już dla kontraktu `compatibility` (`backward`, `forward`, `full`, `none`), a dla systemu `policies.breaking` (`expand-contract`, `versioned`, `forbidden`). Projekt F7 ([design/08 §6 S4](../design/08-system-landscape.md)) zakłada port `ContractDiffer` z dostawcą OpenAPI i krok bramki.

## Decyzja
- **Port `ContractDiffer`** (`kind`, `compare(before, after)`) zwraca zmiany (`code`, `severity`: `breaking`, `non-breaking`, `unclassified`, `location`, `message`) i wersje specyfikacji przed i po. Typy zmian żyją w domenie (`domain/contract-diff.ts`), a port tylko je zwraca.
- **Dostawca OpenAPI** to `OpenApiContractDiffer` w `plugin-openapi` na pakiecie `openapi-diff` (Atlassian):
  - porównuje ścieżki, metody, kody statusu, nagłówki oraz ciała żądań i odpowiedzi (przez `json-schema-diff`);
  - OpenAPI 3.0 i Swagger 2 rozpoznaje po polu `swagger`;
  - specyfikacje przekazuje jako tekst, więc nic nie idzie do sieci;
  - błąd parsowania albo walidacji to `PARSE_FAILED`, a nie wyjątek.
- **Status kontraktu:** `unchanged`, `compatible`, `unclassified`, `breaking`, `added`, `removed`. Wystarczy jedna zmiana `breaking`, żeby kontrakt był `breaking`. Usunięta specyfikacja to `removed` i liczy się jak zmiana łamiąca.
- **Werdykt** (`judgeContract`):
  - `compatibility: none` zawsze przechodzi;
  - zmiana łamiąca przechodzi tylko pod polityką `versioned` i tylko z nową wersją główną (`info.version`, przez `semver.coerce`);
  - pod `expand-contract` nie przechodzi, a podpowiedź mówi: najpierw rozszerz, potem zmigruj konsumentów, potem usuń stare;
  - pod `forbidden` nie przechodzi nigdy;
  - zmiany niesklasyfikowane przechodzą z ostrzeżeniem;
  - konsumenci z zakresem (`billing-api@^1`) dostają `satisfied` względem nowej wersji, a ci spoza zakresu są wymienieni w powodzie;
  - na razie `backward`, `forward` i `full` są traktowane jednakowo, jak `backward`.
- **Zakres:** kontrakty dostarczane przez aplikacje tego repozytorium (`self` z ADR-0068) albo wskazane `--contracts`. Wskazanie kontraktu innego dostawcy to `USAGE`. Specyfikacja w bazie pochodzi z `RevisionReader.readAt` (merge base z `--base`), a ta po zmianie z drzewa roboczego. Rodzaj bez differa daje `unclassified`.
- **CLI i bramka:**
  - `contract diff [--base] [--contracts] [--check]`; `--check` kończy się `CHECK_FAILED`;
  - krok bramki `metator: contract diff`, z powodem dla każdego niedozwolonego kontraktu;
  - krok to tylko nowa wartość tekstu kroku, bez zmiany schematu `MetatorConfig` v4.
- **Zależności:**
  - `openapi-diff` w `plugin-openapi`;
  - `semver` (z `@types/semver`) w core, dopisany do zatwierdzonych czystych bibliotek (reguła `mt-arch-core-approved-deps`), bo zakresy wersji konsumentów to logika domeny.

## Konsekwencje
### Pozytywne
- Zmiana łamiąca kontrakt zatrzymuje się w bramce repozytorium dostawcy, z nazwami konsumentów, zanim trafi na produkcję.
- Polityka mapy jest wykonywalna, a nie tylko opisowa.
- e2e na prawdziwym repozytorium:
  - dodana ścieżka jest zgodna;
  - usunięta ścieżka zatrzymuje `--check` i bramkę pod `expand-contract`;
  - pod `versioned` nowa wersja główna przechodzi, a konsument `^1` jest wymieniony.
### Negatywne
- `openapi-diff` nie klasyfikuje zmian parametrów (np. parametr zapytania, który stał się wymagany) ani OpenAPI 3.1. Takie zmiany nie są wykrywane albo kończą się `PARSE_FAILED`.
- `openapi-diff` przynosi około 30 pakietów (swagger-parser, axios, lodash). Używamy tylko `diffSpecs` z treścią, bez pobierania.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| `oasdiff` (Go) | najpełniejsze reguły, ale to binarka spoza npm do instalowania na każdej maszynie i w CI |
| Własny differ OpenAPI | dużo przypadków (`$ref`, schematy JSON), a gotowy pakiet istnieje (ADR-0010) |
| Ocena zgodności tylko po `info.version` | wersja to deklaracja autora; liczy się, co naprawdę zmieniło się w specyfikacji |
| `Bun.semver` w core | core nie używa API Bun (reguła `mt-arch-no-bun-global-in-core`) |

## Implikacje dla kodu
ADR-0069 egzekwują reguły kanonu MT-CODE-005, MT-TEST-002 (`metator rules show <id>`).
