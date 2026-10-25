# ADR-0005: Kanoniczny format agentów i generatory hostów

- Status: Proposed
- Data: 2026-10-25
- Źródło: [ARCHITECTURE.md §11](../ARCHITECTURE.md)

## Kontekst
Copilot i Claude Code mają różne formaty agentów, skilli, instrukcji i hooków, które zmieniają się między wersjami.

## Decyzja
Agenci, skille, workflowy i reguły są pisane raz w formacie neutralnym (abstrakcyjne uprawnienia, tiery modeli, delegaci). Pluginy hostów generują z nich pliki `.github/*` i `.claude/*`. Mapowanie nazw narzędzi hosta żyje w jednej tabeli w pluginie hosta i ma test snapshotowy. Pliki wygenerowane są oznaczone nagłówkiem, a `metator generate --check` pilnuje spójności w CI.

## Konsekwencje
### Pozytywne
- Zmiana u dostawcy hosta to jedna poprawka.
- Ten sam kanon działa interaktywnie i headless.

### Negatywne
- Pliki hostów nie są edytowane ręcznie: rozszerzenia przez partiale i overrides.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Ręczne utrzymywanie plików per host | dryf i duplikacja |
