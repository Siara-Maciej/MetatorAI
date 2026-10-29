# ADR-0026: Duplikaty wiedzy i macierz dostępu do pamięci

- Status: Accepted
- Data: 2026-10-26

## Kontekst
Ta sama reguła albo to samo twierdzenie zapisane w kilku plikach (instrukcja, prompt, ADR, dokument architektury) rozjeżdża się po pierwszej zmianie. Procedura mapy pamięci ([krok 3](../design/03-memory-map.md#krok-3-deduplikacja-i-wykrywanie-konfliktów-metator-memory-dupes)) wymaga wykrywania duplikatów, a [krok 8](../design/03-memory-map.md#krok-8-macierz-dostępu-agent--pamięć) macierzy agent × pamięć.

## Decyzja
- **`memory dupes [--min-words 8] [--threshold 0.8] [--check]`:**
  - zdania są dzielone przez `Intl.Segmenter` (standard platformy, bez własnego tokenizera);
  - brana jest tylko proza: w Markdown bez kodu, nagłówków, wierszy tabel i cytatów; w YAML tylko pola tekstowe (`summary`, `description`, `intent`…);
  - podobieństwo to Jaccard na 3-gramach słów; kandydaci pochodzą z indeksu odwrotnego, grupy tworzy union-find;
  - powtórzenie w obrębie jednego pliku nie jest duplikatem;
  - kopie generowane (pozycje `derived`) są pomijane;
  - dla każdej grupy `keep` wskazuje wystąpienie w kanonie T1.
- **`memory matrix`:** macierz z pól `readers`/`writers` mapy (`*` daje odczyt każdemu, adnotacje w nawiasach są pomijane), jako dane i jako tabela Markdown.
- `memory dupes --check` jest częścią `bun run canon`.

## Konsekwencje
### Pozytywne
- Powielone twierdzenie jest czerwone w CI z podpowiedzią, gdzie je zostawić. Pierwsze uruchomienie znalazło duplikat między ADR-0004 a ARCHITECTURE.md, który zastąpiono odnośnikiem.
### Negatywne
- Dopasowanie leksykalne, nie semantyczne: to samo zdanie w dwóch językach albo przeformułowane nie zostanie wykryte. Sprzeczności treści nadal wymagają człowieka.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Embeddingi i podobieństwo semantyczne | zależność od modelu, niedeterministyczne wyniki w CI |
| Porównywanie każdej pary zdań | kwadratowy koszt; indeks odwrotny daje tylko kandydatów |
| Biblioteki MinHash/LSH | przy tysiącach zdań dokładny Jaccard z indeksem jest szybszy i prostszy |

## Implikacje dla kodu
ADR-0026 egzekwują reguły kanonu MT-CODE-002 (`metator rules show <id>`).
