# ADR-0021: Mapa pamięci jako wersjonowany dokument i strażnik CI

- Status: Accepted
- Data: 2026-10-25

## Kontekst
Pamięć agentów (instrukcje, ADR, reguły, karty, indeksy, artefakty runów) rozrasta się „bokiem”: nowe pliki nikt nie klasyfikuje, stale ładowane instrukcje przekraczają budżet kontekstu, a twierdzenia o kodzie przestają być prawdziwe. [Mapa pamięci](../design/03-memory-map.md) opisuje rejestr nośników wiedzy i procedurę jego budowy.

## Decyzja
- **Dokument** `MemoryMap` (YAML, `kind` + `schemaVersion`, ADR-0016) w `docs/metator/memory-map.yml`. Pozycja ma `id`, `tier` (T0–T5), `kind` (canon/derived/working/learned/external), `paths` (globy), `load` (`always | explicit | applyTo: | skill: | query:`), `writers`, `readers`, opcjonalny `budget` (znaki/linie/tokeny na plik) i `citations`. `tierBudgets` limituje sumę tieru (np. T0, czyli to, co jest zawsze w kontekście). `knowledge.include/exclude` mówi, które pliki repo są wiedzą.
- **Komendy:**
  - `memory inventory`: krok 1 procedury, działa także bez mapy;
  - `memory budget`, `memory validate [--fix]` (cytaty);
  - `memory check`: strażnik CI. Każdy plik wiedzy jest objęty pozycją mapy, budżety są dotrzymane, cytaty prawdziwe; pozycje bez plików i nakładanie się pozycji to ostrzeżenia.
- **Cytaty** `[[cite: path:line | "quote"]]`: cytat jest prawdziwy, gdy fragment (znormalizowane białe znaki, może obejmować kilka linii) zaczyna się w podanej linii. Gdy kod się przesunął, cytat dostaje status `moved` (szukamy w oknie ±10 linii, najbliższy wygrywa, albo jednoznacznego wystąpienia w całym pliku), a `--fix` poprawia numer linii. Gdy fragmentu nie ma, status to `stale` i nigdy nie jest naprawiany automatycznie: twierdzenie wymaga ponownej weryfikacji.
- W Markdown cytaty w blokach kodu i `code spans` są przykładami, nie twierdzeniami (maskowane przed parsowaniem, z zachowaniem pozycji).
- Domyślnie walidowane są cytaty w pamięci `canon` i `learned`.

## Konsekwencje
### Pozytywne
- Nowy plik wiedzy bez klasyfikacji, przekroczony budżet T0 i nieaktualne twierdzenie o kodzie są czerwone w CI (`bun run canon`).
- Ruch kodu nie unieważnia wiedzy bez potrzeby: `--fix` utrzymuje numery linii.
### Negatywne
- Szukanie poza oknem ±10 to rozszerzenie względem pierwotnej procedury (tam: tylko okno). Przyjęte, bo jednoznaczne wystąpienie nie budzi wątpliwości, a niejednoznaczne zostaje `stale`.
- `memory dupes` i `memory matrix` nie są jeszcze zaimplementowane.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Mapa w Markdown | brak walidacji schematem i ścieżek błędów |
| Cytaty jako zwykłe linki `file#L41` | brak treści do weryfikacji: link wskazuje linię, ale nie mówi, co tam powinno być |

## Implikacje dla kodu
ADR-0021 egzekwują reguły kanonu MT-CODE-002 (`metator rules show <id>`).
