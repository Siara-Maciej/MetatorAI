# ADR-0114: Czat folderu: rozmowa w folderze repozytoriów, a nie w jednym z nich

- Status: Proposed
- Data: 2026-11-27

## Kontekst
Decyzja właściciela produktu z 2026-11-27: w folderze repozytoriów „+ New chat” ma otwierać rozmowę na poziomie folderu, a nie w jednym repozytorium.

Stan dzisiejszy:
- Wątek, jego panel i agent rozmowy należą do jednego repozytorium (ADR-0095, ADR-0093). `POST /threads` trafia do kontenera repozytorium, zapis wątku leży w jego `.metator/`, a panel startuje hosta w korzeniu tego repozytorium (`Threads.openChat`, `Panes.openWorkspace`).
- Aplikacja wybiera repozytorium sama: zapamiętane, a gdy żadnego nie zapamiętano, pierwsze z listy (`repoChoice`, `packages/desktop/src/shared/model/places.ts`). Przycisk „+ New chat” nie mówi, które to repozytorium, a select `repository` jest tylko na ekranach list. Osoba, która dodała folder z czterema repozytoriami i kliknęła „+ New chat”, dostała czat w pierwszym z nich.
- ADR-0057 mówi, że folder niczego nie współdzieli i niczego nie konfiguruje, a „jeden Metator dla całego folderu” jest alternatywą odrzuconą. ADR-0095 zostawił zasięg wątku (repozytorium czy folder) jako pytanie otwarte.
- Host szuka agenta i ustawień w katalogu, w którym startuje. Claude Code uruchomiony w folderze nie widzi `.claude/agents/mt-chat.md` żadnego z repozytoriów ani ich hooków.
- W folderze działają tylko komendy z `FOLDER_COMMANDS`; każda inna kończy się `USAGE` z podpowiedzią `-C <repository>`.
- Run należy do jednego repozytorium. Czat może już dziś wystartować run w innym repozytorium folderu (`Threads.linkRun` z rekordem runu spoza własnego repozytorium), a zmiana przez kilka aplikacji jest planem systemowym.

## Decyzja
1. **Folder repozytoriów ma własny czat.** W aplikacji otwartej na folderze „+ New chat” (przycisk, klawisz `n`, „Describe a task” na Home) otwiera czat folderu. Czat jednego repozytorium zostaje dostępny z menu przy przycisku, z nazwą repozytorium. Aplikacja otwarta na jednym repozytorium działa jak dotąd.
2. **Folder dostaje minimalny własny zapis, tylko dla rozmowy.** `<folder>/.metator/` trzyma wątki czatu folderu i układ jego paneli. Folder nadal nie ma reguł, workflowów, bramek, indeksu ani runów: te zostają w repozytoriach. To zawęża zdanie ADR-0057 „folder niczego nie konfiguruje” do „folder nie konfiguruje pracy nad kodem”.
3. **Agent rozmowy w folderze jest kopią z repozytoriów.** Przy otwarciu czatu folderu demon kopiuje do folderu pliki hosta agenta rozmowy (`.claude/agents/mt-chat.md` i odpowiedniki innych hostów) z pierwszego repozytorium, które je ma, i nadpisuje kopię, gdy się różni (`adoptChatAgent`). Folder nie ma własnego setupu ani własnych hooków; nie musi być repozytorium git, więc tych plików nikt nie commituje.
4. **Agent w folderze pracuje przez `-C`.** Startuje w korzeniu folderu, a pierwszy prompt (`folderChatPrompt`) mówi mu, w jakim folderze jest, jakie ma repozytoria i że każdą komendę jednego repozytorium uruchamia jako `metator -C <repozytorium> …`. Run, szybka zmiana i edycja zawsze należą do jednego repozytorium, które agent nazywa przed startem; gdy kod nie rozstrzyga, pyta osobę. Czat folderu sam nie edytuje plików. Zmiana, która sięga kilku repozytoriów, to `mt-system-change`. Nic nie zgaduje repozytorium za człowieka (ADR-0057 w tej części bez zmian).
5. **Komendy rozmowy działają w folderze.** `thread *` i `session *` dochodzą do komend folderu i pracują na zapisie folderu.
6. **Demon.** Demon folderu obsługuje sam folder jako miejsce o nazwie `.` (`FOLDER_PLACE`; żadne repozytorium nie może się tak nazywać): `?repo=.` w trasach wątków, układu i paneli. Folder ma wątki i panele, nie ma runów. Wątek folderu wymienia runy dowolnego repozytorium; fakty o ich końcu i powiadomienia czatu demon czyta z repozytorium, które trzyma run. Identyfikator nowego wątku jest unikalny w całym folderze, bo aplikacja pokazuje wątki wszystkich miejsc na jednej liście.
7. **Czat folderu jest domyślny, gdy folder ma więcej niż jedno repozytorium.** Folder z jednym repozytorium (także z jego worktree) otwiera czat w repozytorium, jak dotąd.

## Konsekwencje
### Pozytywne
- Folder zachowuje się tak, jak go osoba dodała: jedna rozmowa widzi wszystkie repozytoria, a repozytorium wybiera się przy pracy, nie przy otwarciu czatu.
- Znika ciche domyślne repozytorium w „+ New chat”.
- Pytanie otwarte ADR-0095 o zasięg wątku ma odpowiedź: wątek jest repozytorium albo folderu, a zapis leży tam, gdzie wątek.

### Negatywne
- Folder przestaje być samym zbiorem: ma `.metator/` i kopię agenta rozmowy, których nikt nie sprząta przy usunięciu folderu z aplikacji.
- Dwa rodzaje czatu (folderu i repozytorium) w jednym pasku bocznym; wiersz wątku musi mówić, czyj jest.
- Agent w folderze nie ma hooków, reguł i indeksu repozytorium, dopóki nie wejdzie w repozytorium przez `-C`; czyta kod kilku repozytoriów bez ich kart modułów w kontekście startowym.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Wybór repozytorium przy „+ New chat” | właściciel odrzucił 2026-11-27: rozmowa o folderze nie powinna zaczynać się od wyboru jednego repozytorium |
| Czat w jednym repozytorium z pozostałymi jako `--add-dir` | host dalej startuje w jednym repozytorium (jego hooki, reguły, nagłówek sesji); osoba widzi czat „w mowafaqa-backend”, a nie w folderze |
| Pełny Metator folderu (wspólne reguły, workflowy, runy) | odrzucone już w ADR-0057: repozytoria mają różne reguły i hosty; run zmieniający kod musi należeć do jednego repozytorium |
| Zapis wątków folderu w jednym z repozytoriów | wątek folderu trafiłby do historii git repozytorium, które go nie dotyczy, i znikał z folderu po jego usunięciu |

## Odpowiedzi właściciela (2026-11-27)
- Folder może mieć pliki MetatorAI (`.metator/`, kopia agenta w `.claude/`).
- Czat folderu nie edytuje plików; każda zmiana kodu idzie przez run albo szybką zmianę w repozytorium.
- Czat folderu jest domyślny tylko przy więcej niż jednym repozytorium.

## Pytania otwarte
- Hooki hosta w folderze (`guard *`): czat folderu działa dziś bez nich; zgody na commit i push pilnują hooki repozytorium, w którym pracuje run.
- Piaskownica sesji czatu folderu (ADR-0104): dziś jak dla katalogu bez konfiguracji; zakres zapisu ograniczony do folderu wymaga osobnej decyzji.
- Kontenery deweloperskie (ADR-0106): folder po stronie kontenera czy maszyny?

## Zastępuje i rozszerza
- Zawęża ADR-0057: folder ma zapis rozmowy i pliki hosta; reszta decyzji zostaje.
- Rozszerza ADR-0095 (zasięg wątku) i ADR-0093 (agent rozmowy w folderze).

## Implikacje dla kodu
ADR-0114 egzekwują reguły kanonu MT-TEST-001 (e2e `e2e/folder-chat.e2e.test.ts`, `e2e/desktop-folder-chat.e2e.test.ts`) i MT-TEST-003 (mutanty w `scripts/mutants.ts`). Kod:

- `packages/core/src/domain/repo-set.ts` (`FOLDER_PLACE`), `domain/thread.ts` (`threadTree`), `application/threads.ts`, `application/panes.ts` (`folderChatPrompt`), `application/host-descriptors.ts` (`adoptChatAgent`), `application/chat-notices.ts`.
- `packages/cli/src/serve/server.ts`, `serve/routes/threads.ts`, `serve/routes/sessions.ts`, `serve/timers.ts`; `commands/thread.ts`, `commands/session.ts`.
- `packages/desktop/src/shared/model/places.ts`, `features/threads/chat-actions.ts`, `app/sidebar/sidebar.tsx`.
