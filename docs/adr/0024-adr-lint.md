# ADR-0024: `adr lint`: łańcuch ADR → reguła i spójny dziennik decyzji

- Status: Proposed
- Data: 2026-10-26

## Kontekst
[Zasady §4](../design/01-principles.md#4-adr-docsadr) wymagają, żeby każdy ADR `Accepted` miał sekcję „Implikacje dla kodu” z listą reguł, które z niego wynikają. Inaczej łańcuchu ADR → reguła → egzekucja nie da się prześledzić. Dziennik decyzji rozjeżdża się też z indeksem (`docs/adr/README.md`) i ze statusami, gdy decyzje są zastępowane.

## Decyzja
- ADR zachowują format społeczności (styl Nygarda: tytuł `# ADR-NNNN: …`, `- Status:`, `- Date:`/`- Data:`, sekcje Context/Decision/Consequences). Są parsowane, a nie stemplowane nagłówkiem `kind`/`schemaVersion`: to świadomy wyjątek od MT-CODE-002 dla plików pisanych przez ludzi w ustalonym formacie.
- Nagłówki sekcji są rozpoznawane po angielsku i po polsku.
- `metator adr lint` sprawdza:
  - nazwę pliku `NNNN-tytul.md` i zgodny numer w tytule, oraz unikalne numery;
  - status ze znanego zbioru; `Superseded by` musi wskazywać istniejący ADR;
  - datę (jej brak to ostrzeżenie) i wymagane sekcje;
  - ADR `Accepted`: sekcję „Implications for code” / „Implikacje dla kodu” z co najmniej jednym ID reguły z kanonu;
  - każde ID reguły poza blokami kodu musi istnieć w kanonie;
  - indeks linkuje każdy ADR, pokazuje jego aktualny status i nie linkuje nieistniejących plików.
- `adr lint` jest częścią `bun run canon`.

## Konsekwencje
### Pozytywne
- Akceptacja ADR (decyzja człowieka) od razu wymaga powiązania z regułami, a nieaktualny indeks jest czerwony w CI.
### Negatywne
- Rozpoznawanie sekcji dotyczy tylko dwóch języków; inne trzeba będzie dodać w konfiguracji (`metator.config`).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| log4brains / adr-tools | narzędzia do tworzenia i publikacji ADR, nie walidują powiązań z kanonem reguł |
| Nagłówek `kind`/`schemaVersion` w każdym ADR | zmusza ludzi do formatu narzędzia; ADR to dokumenty dla ludzi |
