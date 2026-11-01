# ADR-0074: Moduły wewnątrz pakietu: modularny monolit analizowany jak monorepo

- Status: Proposed
- Data: 2026-10-30

## Kontekst
`metator arch` (ADR-0061, ADR-0062) traktuje jako jednostki architektury pakiety workspace'u. Modularny monolit to jeden pakiet z kilkunastoma modułami w katalogach, na przykład aplikacja NestJS z `src/module/*`. Taki monolit był dla `arch` jedną jednostką: zero cykli, zero granic. Na prawdziwym backendzie (17 modułów, jeden pakiet) `arch analyze` nie pokazał nic. Tymczasem jego własny audyt opisuje 11 par modułów, które importują się nawzajem, a zespół ma regułę: inne moduły importuje się tylko przez `contracts/`.

Analiza pakietów nie pasuje do modułów. Import innego modułu nie jest deklarowany w `package.json`, więc reguły `undeclared`, `relative-import` czy `dev-in-prod` zgłaszałyby każdy taki import.

## Decyzja
- **`modules` w polityce (ArchitecturePolicy v2):**
  - `globs` to katalogi modułów (`src/module/*`, `apps/*/features/*`);
  - `public` (opcjonalne) to ścieżki wewnątrz modułu, które wolno importować innym (`contracts/**`).

  Bez `public` każdy plik jest publiczny.
- **Osobna analiza modułów** (`domain/architecture-modules.ts`), a nie udawane pakiety. Liczy:
  - pliki;
  - krawędzie (importy, z tego runtime);
  - pary, które importują się nawzajem;
  - cykle (silnie spójne składowe, Tarjan z graphlib);
  - importy z pominięciem części publicznej.

  Testy się nie liczą. Moduł nazywa się jak katalog. Katalogi o tej samej nazwie w różnych pakietach nazywa pakiet i katalog (`mowafaqa-web/Auth`), a gdy to nie wystarcza, ścieżka.
- **Dwa nowe rodzaje naruszeń:**
  - `module-cycle` (error; warning, gdy cykl zamyka tylko `import type`);
  - `module-internal` (error).

  Działają na nich te same mechanizmy co na pakietach: `severity`, wyjątki, baseline i `arch check --base`.
- **Raport** (ArchitectureReport v2) ma sekcję `modules`, a raport Markdown sekcję „Modules”.
- **`arch init`** proponuje `modules`, gdy w repozytorium jest katalog `module`, `modules`, `features`, `domains` lub `contexts` z co najmniej trzema podkatalogami. `public: [contracts/**]` proponuje, gdy moduły już mają `contracts/`.
- **Nowe wersje dokumentów:** ArchitecturePolicy, ArchitectureReport i ArchitectureBaseline dostają v2. Wersja 1 zostaje zamrożona ze starą listą rodzajów naruszeń. Migracja v1 → v2 to tożsamość, bo v2 tylko dodaje.

## Konsekwencje
### Pozytywne
- Modularny monolit ma architekturę w CI. Na prawdziwym backendzie `arch analyze` pokazuje 12 par modułów, które importują się nawzajem, dwie silnie spójne składowe (9 i 4 moduły) i 57 par z importami z pominięciem `contracts/`. `arch check` z baseline'em zatrzymuje tylko nowy taki import.
- Frontend zorganizowany po feature'ach (`apps/*/features/*`) dostaje to samo bez zmian w kodzie.
- Reguła zespołu „tylko przez contracts/” jest sprawdzana przez narzędzie, a nie przez recenzenta.

### Negatywne
- Moduł to katalog, nie pakiet: nie ma metryk Martina, kandydatów do podziału ani kart modułów. To osobna praca.
- Polityka v1 i v2 się różnią: starsza wersja MetatorAI nie odczyta polityki z `modules`.

## Implikacje dla kodu
- Nowe rodzaje naruszeń dopisuje się do `VIOLATION_KINDS`. `VIOLATION_KINDS_V1` się nie zmienia; nowa lista to nowa wersja dokumentów (MT-CODE-003).
- Analiza modułów jest czystą funkcją domeny (MT-ARCH-001), a fakty zbiera `ArchitectureFacts` jak dla pakietów.
