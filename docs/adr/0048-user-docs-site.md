# ADR-0048: Dokumentacja użytkownika jako strona VitePress na GitHub Pages

- Status: Proposed
- Data: 2026-10-26

## Kontekst
Użytkownik MetatorAI potrzebuje dokumentacji produktu: instalacji, szybkiego startu, workflowów, poradników z przykładami (co, po co, dlaczego) i pełnej referencji CLI. README był częściowo nieaktualny:
- opisywał instalację z npm i `metator.config.ts`;
- wspominał `metator doctor`, którego nie ma;
- miał stary stan prac.

Dokumenty projektowe w `docs/` są po polsku i są dla zespołu, nie dla użytkownika.

## Decyzja
- **Strona w `site/`** na **VitePress 1.6.4** (MIT): dojrzały generator dokumentacji narzędzi TypeScript, z wyszukiwaniem lokalnym i nawigacją. Jest po angielsku, jak README i CLI. Kod dokumentacji nie wchodzi do pakietów produktu, a strony nie są plikami wiedzy agentów (mapa pamięci ich nie obejmuje).
- **Referencja CLI jest generowana z commandera** (`bun run site:reference`, `scripts/site/cli-reference.ts`), więc nie rozjeżdża się z CLI. `--check` jest w teście e2e i w workflow strony.
- **Test e2e strony:**
  - referencja aktualna;
  - każdy dostarczany agent i każdy rodzaj dokumentu (`docs/metator/schemas`) opisany;
  - strona zbudowana i otwarta w prawdziwym Chromium: tytuły sekcji, 200, brak błędów konsoli.

  VitePress sam przerywa build przy martwym linku.
- **Przykłady na stronie pochodzą z prawdziwej sesji** na repo demonstracyjnym (Bun workspace z dwoma pakietami). Przykład konfiguracji jest wczytany przez `metator config show`.
- **GitHub Pages przez GitHub Actions** (`.github/workflows/pages.yml`):
  - build przy każdym pushu i PR;
  - publikacja z `main` i `claude/foundation`;
  - ścieżka bazowa z `actions/configure-pages`.

  Jednorazowo trzeba włączyć Pages w ustawieniach repo (źródło: GitHub Actions) i dopuścić gałąź do środowiska `github-pages`.
- README to wizytówka z linkami do strony i krótkim, prawdziwym szybkim startem.

## Konsekwencje
### Pozytywne
- Jedno miejsce z instrukcjami dla użytkownika; referencja i lista agentów nie mogą się zestarzeć niezauważone.
### Negatywne
- Strony pisane ręcznie (poradniki) mogą się zestarzeć; testy łapią tylko referencję, agentów i rodzaje dokumentów.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Docusaurus | cięższy (React, więcej zależności) przy tych samych potrzebach |
| MkDocs Material | wymaga Pythona w repo opartym na Bun |
| Ręczny HTML | brak wyszukiwania i nawigacji, wszystko trzeba by utrzymywać ręcznie |
