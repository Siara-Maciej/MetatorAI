# ADR-0067: `system discover`: topologia, aplikacje, kontrakty i konsumenci z dowodami

- Status: Proposed
- Data: 2026-10-29

## Kontekst
Mapa systemu (ADR-0047) to deklaracja zatwierdzana przez człowieka. Pisana od zera rzadko powstaje, a pisana raz szybko się rozjeżdża z kodem. Projekt F7 ([design/08 §6 S2](../design/08-system-landscape.md)) zakłada, że MetatorAI sam rozpoznaje topologię, aplikacje, specyfikacje i konsumentów, z dowodami i pewnością, a zatwierdzonej mapy nigdy nie nadpisuje.

## Decyzja
- **Topologia:**
  - `repos`, gdy komenda działa w folderze repozytoriów (G2); każde repozytorium jest źródłem;
  - `monorepo`, gdy w repozytorium jest kilka aplikacji;
  - `single`, gdy jest jedna.
- **Aplikacje:**
  - pakiety workspace sklasyfikowane jako `app` przez analizę architektury (ADR-0061) oraz pakiety z `Dockerfile`, który robi z pakietu jednostkę wdrożenia (`deploy.unit`);
  - repozytorium bez pakietów workspace to jedna aplikacja;
  - w folderze źródło to `{ repo: <remote albo nazwa>, path? }`, w repozytorium `{ path }`;
  - id pochodzi z nazwy pakietu bez scope'u, a kolizje dostają prefiks repozytorium;
  - rodzaj: `service` (specyfikacja albo framework serwerowy), `frontend` (React, Vue, Svelte…), `worker` i `gateway` z nazwy, `other` dla narzędzia z `bin` (także rysującego w React przez Ink) i reszty;
  - właściciele pochodzą z `CODEOWNERS`.
- **Kontrakty:**
  - port `ContractDetector` (rodzaj, globy, `detect`), pierwszy adapter w nowym pakiecie `plugin-openapi`;
  - OpenAPI 3 i Swagger 2 w YAML/JSON z tytułem, wersją i `servers` (dla Swaggera z `schemes`, `host`, `basePath`);
  - właścicielem jest najgłębsza aplikacja zawierająca plik, a specyfikacja poza aplikacjami nie ma dostawcy;
  - id pochodzi z tytułu i jest unikalne.
- **Konsumenci** (pliki innej aplikacji, z pominięciem `node_modules`, buildów, lockfile'ów i plików ponad 256 KB):
  - odwołanie do ścieżki specyfikacji z katalogu dostawcy (`billing/openapi.yaml`) to pewność `medium`, proponowane;
  - wywołanie hosta z `servers` to pewność `low`, pokazywane, nieproponowane. Liczą się tylko hosty z kropką albo portem, bez `localhost`, bo samo słowo trafia za często.
- **Wynik:**
  - `topology`, `proposal` (poprawny `SystemMap`), `evidence` (podmiot, powód, plik, pewność, czy proponowane), `drift` względem istniejącej mapy;
  - `--write` zapisuje mapę tylko wtedy, gdy jej nie ma (folder nie ma własnej mapy);
  - `--check` kończy się `CHECK_FAILED`, gdy mapie brakuje tego, co pokazuje kod.
  
  `system discover` działa także w folderze repozytoriów (`FOLDER_COMMANDS`).
- **Bez nowej zależności:** specyfikacje są parsowane biblioteką `yaml`, którą już mamy. Pełna walidacja `$ref` (`swagger-parser`) nie jest potrzebna do rozpoznania.

## Konsekwencje
### Pozytywne
- Mapa powstaje z kodu, a w CI `--check` pilnuje, żeby nowa aplikacja albo nowy konsument nie umknęli.
- e2e:
  - monorepo z trzema aplikacjami: usługa z `Dockerfile` i specyfikacją, frontend generujący klienta ze specyfikacji, worker wołający host specyfikacji;
  - folder trzech repozytoriów;
  - zapis raz, lint mapy, wykrycie dryfu po dodaniu aplikacji.
### Negatywne
- Konsument, który nie odwołuje się ani do specyfikacji, ani do hosta (np. adres z sekretów), nie zostanie znaleziony. Mapa pozostaje deklaracją do uzupełnienia przez człowieka.
- Heurystyki rodzaju aplikacji są proste i rodzaj może wymagać poprawki w propozycji.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| `@apidevtools/swagger-parser` do rozpoznania | waliduje i rozwiązuje `$ref`, czego rozpoznanie nie potrzebuje; nowa zależność bez zysku |
| Konsumenci z niskiej pewności w mapie | mapa to deklaracja; zgadywanie trafiałoby do niej bez przeglądu |
| Nadpisywanie mapy przy `--write` | zatwierdzona mapa jest kanonem; dryf pokazuje `--check` |
