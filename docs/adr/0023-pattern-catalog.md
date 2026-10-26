# ADR-0023: Katalog wzorców z wykrywaniem w ast-grep i `similar`

- Status: Proposed
- Data: 2026-10-26

## Kontekst
Agent tworzący nowy plik powinien skopiować sposób, w jaki repo już to robi, a nie wymyślać go od nowa ani kopiować kodu legacy. Szukanie „podobnego modułu” zależy dziś od szczęścia ([zasady](../design/04-commands.md)), a wzorzec bez exemplara i bez wykrywania szybko przestaje odpowiadać kodowi.

## Decyzja
- **Dokument** `Pattern` (YAML, ADR-0016), jeden plik na wzorzec w `docs/metator/patterns/<id>.yml`. Pola:
  - `intent`, `when`, `whenNot`;
  - `detection` w postaci `<engine>:<rule id>`;
  - `exemplar`: plik do skopiowania;
  - `rules`: ID z kanonu;
  - `legacy`: pliki, których nie wolno kopiować, z powodem;
  - `minOccurrences`.
- **Wykrywanie:** reguła ast-grep z `severity: hint` w `docs/metator/patterns/sg` (z testem w `sg-tests`), dopisana do `sgconfig.yml`. Hinty nie są naruszeniami: `rules check` ich nie raportuje, a `bun run arch` skanuje tylko `mt-arch-*`. Pliki reguł ast-grep mają format narzędzia, nie własny nagłówek MetatorAI.
- **Komendy:**
  - `patterns scan [--check]`: wystąpienia per plik i pakiet, legacy osobno, wersjonowany indeks `.metator/index/patterns.json`. `--check` wymaga, żeby exemplar był prawdziwym wystąpieniem, była wystarczająca liczba wystąpień, reguła wykrywania istniała (brak testu daje ostrzeżenie) i referencje do kanonu były poprawne.
  - `similar [--file <planowany plik>] [opis…] [--top n]`: ranking wystąpień według wspólnych katalogów, rodzaju pliku (`*.queries.ts`) i słów opisu, z exemplarem na czele; nigdy nie zwraca legacy.

## Konsekwencje
### Pozytywne
- Exemplar, który przestał istnieć albo przestał być wzorcem, jest czerwony w CI (`bun run canon`).
- Agent dostaje „jak to tu robimy” jednym zapytaniem, z uzasadnieniem dopasowania.
### Negatywne
- `similar` dopasowuje po ścieżkach i słowach, nie semantycznie; to świadome uproszczenie bez modelu i bez embeddingów.
- Pełny skan ast-grep przy każdym `patterns scan` i `similar`; przy dużych repo trzeba będzie czytać indeks zamiast skanować.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Wzorce jako Markdown z ręczną listą przykładów | lista się rozjeżdża z kodem; brak weryfikacji exemplara |
| Embeddingi do `similar` | zależność od modelu i usług, niedeterministyczne wyniki w CI |
| Reguły wykrywania jako `severity: info` w regułach architektury | mieszają wzorce z naruszeniami; osobny katalog jest czytelniejszy |
