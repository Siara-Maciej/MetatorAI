# ADR-0097: Review: cudzy MR z linku, publikacja po jednej zgodzie, obserwowanie i ponowne review; moje MR analizowane na kliknięcie

- Status: Proposed
- Data: 2026-11-21

## Kontekst
Właściciel produktu ustalił w rozmowie 2026-11-20/21, jak ma działać review cudzych i własnych MR.

Stan dzisiejszy, cudzy MR:
- Review robi workflow `mt-pr-review` (`.github/metator/workflows/mt-pr-review.yml`, ADR-0032): etapy `metadata`, `shard`, `rules`, `find`, `verify`, `judge`, bramka `approval` (daje zgodę `comment`) i `publish`. Metadane pochodzą z gita lokalnego repozytorium (`metator review metadata --base …`), więc review z samego linku, bez lokalnego repozytorium, nie ma.
- Po publikacji nic nie obserwuje MR: nie ma czekania na odpowiedzi autora ani na nowe commity, nie ma ponownego review ze stanem wcześniejszych uwag, nie ma listy MR, w których osobę poproszono o review (`HostPullRequest` w `packages/core/src/domain/review-thread.ts` zna numer, tytuł, gałąź, adres i autora).

Stan dzisiejszy, moje MR (ADR-0083):
- `MyReviews.scan` (`packages/core/src/application/review-watch.ts`) czyta źródła z `reviews.sources`, trzyma wątki w `.metator/mrs/` i przy nowych otwartych wątkach **sam startuje run** workflowu `reviews.workflow` (domyślnie `mt-review-response`) w worktree na gałęzi MR. Demon woła skan z zegara (`packages/cli/src/serve/timers.ts`, co `reviews.everyMs`, domyślnie 120 s) i napędza wystartowany run.
- Wysyłka odpowiedzi (`MyReviews.send`) wymaga nazwiska osoby i wysyła wszystkie niewysłane propozycje naraz; `resolve` też wymaga osoby. Stany wątku to `open`, `answered`, `planned`, `fixed`, `resolved`.
- Dostęp do hosta kodu idzie przez port `ReviewHost` i adapter MCP (`packages/plugin-codehost-mcp/src/mcp-review-host.ts`).
- Źródła są skonfigurowane dwa razy: `intake.rules[].source` (`packages/core/src/domain/intake.ts`) i `reviews.sources` (`ReviewsConfigSchema`), każde z własnym wskazaniem serwera MCP.

## Decyzja
**Cudzy MR**
- **Z linku, tylko gdy da się go odczytać w locie:** przez MCP GitHub/GitLab, `gh` albo inne narzędzie. Inaczej agent mówi, że nie może otworzyć MR.
- **Bez lokalnego repozytorium:** review z samego diffu, z adnotacją. **Gdy repozytorium jest lokalne:** pełny zestaw.
- **Publikacja po jednej zgodzie.** Review jest najpierw odpowiedzią agenta z pytaniem „opublikować?”. Jedna zgoda dotyczy całości. Komentarze są inline (MCP albo inne narzędzie). Gdy inline się nie da, agent to mówi i zwraca listę uwag, a o innej formie decyduje osoba. W konfiguracji jest opcja automatycznej publikacji.
- **Obserwowanie.** Demon czeka na odpowiedzi autora w wątkach i na nowe commity. Osoba dostaje powiadomienie i może zrobić ponowne review jednym kliknięciem: obejmuje ono nowe commity i stan wcześniejszych uwag (poprawione, niepoprawione, sporne), z podglądem prawdziwego terminala agenta.
- **Approve.** Gdy wszystko jest poprawione, agent proponuje approve; zatwierdza zawsze osoba.
- **Co jest obserwowane.** Jedna wspólna konfiguracja źródeł i tokenu. Obserwowane są MR zrecenzowane przez MetatorAI oraz te, w których osobę poproszono o review (karta „poproszono Cię o review”).

**Moje MR**
- **Wykrywanie nowych review: zawsze.**
- **Analiza nie jest automatyczna.** Opcja w konfiguracji (`true`/`false`, domyślnie `false`). Domyślnie w Needs you pojawia się karta „Nowe review w MR #N (wątki…)” z przyciskiem „Przeanalizuj”.
- **Każdy nowy wątek jest analizowany.**
- **Wysyłka odpowiedzi:** jedna zgoda na całość, chyba że osoba każe wysłać tylko wybrane punkty albo pominąć niektóre.
- **Poprawki:** quick albo pełny workflow, według eskalatorów (ADR-0093).

## Konsekwencje
- Review cudzego MR nie wymaga już lokalnego repozytorium, ale review z samego diffu jest słabsze i mówi o tym wprost.
- Zmienia się domyślne zachowanie dla moich MR: nowe review nie startuje już runu `mt-review-response`, tylko zostawia kartę. Limit jest wydawany dopiero po „Przeanalizuj” albo po włączeniu opcji.
- Demon obserwuje więcej niż dziś: obok moich MR także MR zrecenzowane przez MetatorAI i te z prośbą o review, a obok wątków także nowe commity.
- Publikacja komentarzy i approve są zapisami zewnętrznymi: podlegają zgodzie osoby (ADR-0037, ADR-0094). Automatyczna publikacja jest opcją w konfiguracji; approve zatwierdza zawsze osoba.
- Dwie konfiguracje źródeł (`intake`, `reviews`) schodzą się w jedną; to zmiana dokumentu konfiguracji z migracją.
- Częściowa wysyłka odpowiedzi wymaga wyboru wątków; dzisiejsze `send` wysyła wszystko.
- Treść MR, komentarzy i odpowiedzi autora to nadal dane, a nie instrukcje dla agenta (ADR-0007).

## Zastępuje i rozszerza
- Zmienia jeden punkt ADR-0083: analiza nowego review na moim MR nie jest już automatyczna (domyślnie karta z „Przeanalizuj”).
- Rozszerza ADR-0032 (subflow review) o review z linku, obserwowanie i ponowne review.
- Korzysta z ADR-0091 i ADR-0092 (karty w Needs you, podgląd prawdziwego terminala agenta) i z ADR-0093 (wagi pracy dla poprawek).
- Niczego nie zastępuje w całości.

## Pytania otwarte
- Kolejność narzędzi do odczytu MR z linku (MCP, `gh`, inne) i czy idzie to przez port (`ReviewHost` albo nowy), czy przez narzędzia samego agenta; zakres wsparcia GitLaba.
- Czym „review z samego diffu” różni się od „pełnego zestawu”: które soczewki i bramki odpadają i jak brzmi adnotacja?
- Klucze w konfiguracji dla automatycznej publikacji i dla automatycznej analizy moich MR; wartość domyślna automatycznej publikacji (decyzja podaje ją tylko dla analizy).
- Gdzie zapisane są obserwowane cudze MR (`.metator/mrs/`, zapis wątku z ADR-0095) i kiedy obserwowanie się kończy (merge, zamknięcie, approve)?
- Kto ustala stan uwagi (poprawione, niepoprawione, sporne): agent, narzędzie, czy oba? Jak ma się to do dzisiejszych stanów wątku?
- Approve: jakim narzędziem i na którym poziomie blokad z ADR-0094?
- Wspólna konfiguracja źródeł i tokenu: kształt, migracja z `intake.rules[].source` i `reviews.sources`, miejsce tokenu (dziś w konfiguracji serwerów MCP).
- Los workflowu `mt-review-response` i `reviews.workflow`: czy zostaje jako „pełna” droga poprawek?
- Jak osoba wskazuje punkty do wysłania albo pominięcia: słowami w czacie, zaznaczeniem w aplikacji, czy oboma sposobami?
- Jak często demon sprawdza nowe commity i odpowiedzi w cudzych MR (ten sam `everyMs`)?

## Implikacje dla kodu
Decyzję będą egzekwować MT-CODE-003 (wspólne źródła i nowe opcje to nowa wersja `MetatorConfig`; stan uwag to nowa wersja `PullRequestReview`), MT-TEST-002 (adapter portu hosta kodu uruchamia zestaw kontraktowy `review-host.contract.ts`), MT-TEST-003 (mutanty dla „wykryj, ale nie analizuj” i dla częściowej wysyłki) i MT-TEST-001 (e2e: skan nie startuje runu przy wyłączonej opcji). Kod review zmieni się po akceptacji tego ADR, w tych miejscach:

- `packages/core/src/application/review-watch.ts`: `MyReviews.scan` (automatyczny start runu), `send`.
- `packages/core/src/domain/review-thread.ts`: `ReviewsConfigSchema`, `THREAD_STATES`, `HostPullRequest`.
- `packages/cli/src/serve/timers.ts`: zegar review; `packages/cli/src/commands/mrs.ts`.
- `packages/core/src/domain/intake.ts`: `IntakeSourceSchema` (druga konfiguracja źródeł).
- `.github/metator/workflows/mt-pr-review.yml`, `.github/metator/workflows/mt-review-response.yml`.
- `packages/plugin-codehost-mcp/src/mcp-review-host.ts`; `packages/desktop/src/screens/mrs.tsx`.
