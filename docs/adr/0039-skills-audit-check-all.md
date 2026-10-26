# ADR-0039: Skille kanoniczne, `meta skills-lint`, `meta audit` i `meta check-all`

- Status: Proposed
- Data: 2026-10-26

## Kontekst
Katalog komend (04-commands §I) wymaga lintu skilli, audytu agentów i skilli (wejście do F0) oraz jednego polecenia uruchamiającego wszystkie sprawdzenia. Skille żyły dotąd tylko w szablonie (05-templates §3). `bun run canon` uruchamiał dziesięć osobnych procesów `metator`.

## Decyzja
- **Skill kanoniczny:** `metator/skills/<name>/SKILL.md` z front matter `kind: Skill` (`name`, `description`, `files`) i pliki pomocnicze obok.
- **`SkillGenerator`** to osobny port, oddzielony od `HostGenerator`, który ma już pięć członków (MT-ARCH-008). Format Agent Skills (`name` i `description` w front matter, pliki pomocnicze w katalogu skilla) jest wspólny, więc layout leży w domenie (`agentSkillLayout`). Hosty różnią się tylko katalogiem: `.claude/skills/` i `.github/skills/`. `generate [--check]` obejmuje skille; osierocone pliki wygenerowanych katalogów są zgłaszane.
- **`meta skills-lint`** sprawdza:
  - nazwa = katalog, prefiks `mt-`;
  - opis z triggerem („Use when”/„Użyj, gdy”) i antytriggerem („Do not use”/„Nie używaj”);
  - sekcje szablonu (When, Steps, Output, Checklist, Errors);
  - limit 300 linii;
  - pliki z `files` istnieją, a każdy plik użyty w treści (`scripts/…`, `references/…`) jest w `files`.
- **`meta audit`:** inwentarz agentów, skilli i promptów (kanon, kopie wygenerowane, ręczne pliki w katalogach hostów) oraz graf wywołań (`delegates`, front matter `agents:`, wzmianki nazw). Zgłasza:
  - cykle, liczone tylko po delegacjach („started by mt-x” to odwołanie zwrotne, nie wywołanie);
  - elementy, do których nic nie dochodzi z punktu wejścia;
  - delegacje głębsze niż 2 poziomy;
  - delegacje do nieznanych agentów.
- **`meta check-all [--min-e1]`** uruchamia w jednym procesie 12 sprawdzeń (reguły, pamięć, karty, wzorce, ADR, duplikaty, agenci, skille, workflowy, pliki generowane, pokrycie E1). Robi to przez `invoke` w kontekście komend, więc kryteria zaliczenia są jednym źródłem: każda komenda sama decyduje, czy przeszła. `bun run canon` = `meta check-all --min-e1 100`.
- Dogfood: skill `mt-find-patterns`; skrypty kopiowane bez bitu wykonywania, więc skill woła je przez `sh`, a komenda MetatorAI przychodzi z `$METATOR`.

## Konsekwencje
### Pozytywne
- Skille mają tę samą ścieżkę co agenci: kanon, lint, generowanie, strażnik w CI.
- Audyt F0 działa na repo pilota bez ręcznego inwentarza.
- `canon` trwa ok. 2 s zamiast ok. 10 procesów.
### Negatywne
- Wzmianki nazw w treści są heurystyką (nazwy kebab-case znanych elementów); nieoczywiste wywołania mogą zostać niewykryte.
- Bit wykonywania skryptów nie jest przenoszony (port `FileSystem` zapisuje tekst).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Metoda `skill()` w `HostGenerator` | szósty członek portu (MT-ARCH-008); inna oś zmiany |
| `check-all` jako osobne procesy | wolniej; to samo co dawny skrypt `canon` |
| Kryteria zaliczenia skopiowane do use case'u | dwa źródła prawdy o tym, kiedy sprawdzenie przechodzi |
