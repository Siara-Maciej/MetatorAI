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
- **Struktura jak dokumentacja produktu enterprise, czytana jak książka:** jeden pasek boczny ze zwijanymi rozdziałami w kolejności czytania, bez linków w górnym pasku. Rozdziały:
  1. Get started (idea, zasada działania, instalacja, szybki start);
  2. Concepts;
  3. Workflows;
  4. Agents and skills;
  5. Guides;
  6. Many applications;
  7. Enterprise;
  8. API reference (CLI i koperta JSON, hooki, dokumenty i schematy, rozszerzanie, generowana referencja komend);
  9. Help.

  „Get started” prowadzi przez wszystkie strony linkami „Next chapter”, które wynikają z kolejności w pasku. Test e2e sprawdza, że pasek zawiera każdą stronę i że przejście „Next chapter” od pierwszej strony odwiedza je wszystkie po kolei.
- **Diagramy i animacje jako komponenty Vue czytające kanon** przez data loadery VitePress (`site/.vitepress/data/*.data.ts`):
  - workflowy z `.github/metator/workflows/*.yml` (etapy, właściciele, bramki, pętle, HITL; żeton przechodzi etapy jak `run advance`);
  - agenci i skille z front matter w `metator/agents` i `metator/skills`;
  - mapa komend z wygenerowanej referencji.

  Test e2e porównuje etapy na zbudowanych diagramach z YAML-em, więc diagram nie może się rozjechać z workflowem. Animacje respektują `prefers-reduced-motion`.
- **Biome dla `site/**/*.vue`**: wyłączone `noUnusedVariables` i `noUnusedImports` (Biome nie analizuje szablonów Vue, więc zgłasza zmienne używane w szablonie), a dla CSS i Vue motywu `noImportantStyles` (nadpisywanie stylów VitePress).
- **Przełącznik menedżera pakietów** (npm, pnpm, Yarn, Bun):
  - polecenia zależne od menedżera są w blokach `code-group` z zakładkami w tej kolejności;
  - wybór z dowolnej zakładki, z listy w pasku nawigacji albo z przycisków na stronie instalacji przełącza wszystkie bloki na wszystkich stronach i jest zapamiętany w `localStorage`;
  - stan zakładek jest ustawiany bezpośrednio, bez symulowanych kliknięć, bo VitePress przewija klikniętą zakładkę i strona by skakała.

  Polecenia `metator` nie mają zakładek, bo są takie same w każdym projekcie (globalna komenda z `bun link`). Test e2e sprawdza kolejność zakładek na każdej stronie oraz to, że jeden wybór zmienia wszystko bez przesuwania strony.
- README to wizytówka z linkami do strony i krótkim, prawdziwym szybkim startem.

## Konsekwencje
### Pozytywne
- Jedno miejsce z instrukcjami dla użytkownika; referencja i lista agentów nie mogą się zestarzeć niezauważone.
### Negatywne
- Strony pisane ręcznie (poradniki) mogą się zestarzeć; testy łapią referencję, agentów, skille, rodzaje dokumentów i etapy workflowów.
- Komponenty Vue nie są w pełni lintowane przez Biome (szablony).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Docusaurus | cięższy (React, więcej zależności) przy tych samych potrzebach |
| MkDocs Material | wymaga Pythona w repo opartym na Bun |
| Ręczny HTML | brak wyszukiwania i nawigacji, wszystko trzeba by utrzymywać ręcznie |
