# ADR-0113: Czat folderu: rozmowa w folderze repozytoriów, a nie w jednym z nich

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
3. **Pliki hosta dla folderu.** Dodanie folderu w aplikacji (i `metator repos setup` w terminalu) zapisuje w folderze agenta rozmowy i jego ustawienia dla wybranych hostów (`.claude/agents/mt-chat.md`, `.claude/settings.json`, odpowiedniki Copilota). Są generowane z tego samego źródła co pliki repozytoriów (`metator/agents`), z sekcją folderu zamiast sekcji repozytorium. Folder nie musi być repozytorium git, więc tych plików nikt nie commituje.
4. **Agent w folderze pracuje przez `-C`.** Startuje w korzeniu folderu, na starcie dostaje listę repozytoriów (`metator repos list`) i każdą komendę jednego repozytorium uruchamia jako `metator -C <repozytorium> …`. Run, szybka zmiana i pytanie (`ask`) zawsze należą do jednego repozytorium, które agent nazywa przed startem; gdy kod nie rozstrzyga, pyta osobę. Zmiana, która sięga kilku repozytoriów, to `mt-system-change`. Nic nie zgaduje repozytorium za człowieka (ADR-0057 w tej części bez zmian).
5. **Komendy rozmowy działają w folderze.** `thread *` oraz komendy panelu, z których korzysta czat, dochodzą do `FOLDER_COMMANDS` i pracują na zapisie folderu, gdy wywołuje je panel czatu folderu.
6. **Demon.** Demon folderu obsługuje wątki i panele folderu obok tych z repozytoriów. Wątek folderu nie ma pola `repo`; jego zadania to runy z dowolnego repozytorium folderu, każdy ze swoim `repo`. Drzewo `/threads` łączy wątki folderu i repozytoriów jak dotąd.
7. **Piaskownica i odmowy.** Sesja czatu folderu jest opakowana jak każda sesja hosta (ADR-0104), z zapisem ograniczonym do folderu; lista komend, które nigdy nie działają (ADR-0100), jest sumą list repozytoriów.

## Konsekwencje
### Pozytywne
- Folder zachowuje się tak, jak go osoba dodała: jedna rozmowa widzi wszystkie repozytoria, a repozytorium wybiera się przy pracy, nie przy otwarciu czatu.
- Znika ciche domyślne repozytorium w „+ New chat”.
- Pytanie otwarte ADR-0095 o zasięg wątku ma odpowiedź: wątek jest repozytorium albo folderu, a zapis leży tam, gdzie wątek.

### Negatywne
- Folder przestaje być samym zbiorem: ma `.metator/` i pliki hosta, które trzeba generować, aktualizować (`metator update`) i sprzątać przy usunięciu folderu z aplikacji.
- Dwa rodzaje czatu (folderu i repozytorium) w jednym pasku bocznym; wiersz wątku musi mówić, czyj jest.
- Agent w folderze nie ma hooków, reguł i indeksu repozytorium, dopóki nie wejdzie w repozytorium przez `-C`; czyta kod kilku repozytoriów bez ich kart modułów w kontekście startowym.
- Nowy wersjonowany zapis (wątek bez `repo` w zapisie folderu) i nowy cel generatora.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Wybór repozytorium przy „+ New chat” | właściciel odrzucił 2026-11-27: rozmowa o folderze nie powinna zaczynać się od wyboru jednego repozytorium |
| Czat w jednym repozytorium z pozostałymi jako `--add-dir` | host dalej startuje w jednym repozytorium (jego hooki, reguły, nagłówek sesji); osoba widzi czat „w mowafaqa-backend”, a nie w folderze |
| Pełny Metator folderu (wspólne reguły, workflowy, runy) | odrzucone już w ADR-0057: repozytoria mają różne reguły i hosty; run zmieniający kod musi należeć do jednego repozytorium |
| Zapis wątków folderu w jednym z repozytoriów | wątek folderu trafiłby do historii git repozytorium, które go nie dotyczy, i znikał z folderu po jego usunięciu |

## Pytania otwarte
- Czy czat folderu jest domyślny zawsze, czy tylko gdy folder ma więcej niż jedno repozytorium?
- Co z folderem tylko do odczytu albo takim, w którym osoba nie chce plików MetatorAI: czat jednego repozytorium jako jedyny, czy pliki hosta przekazane hostowi poza folderem?
- Czy czat folderu może sam edytować pliki (tryb `direct` agenta rozmowy), czy każda zmiana kodu idzie przez run albo szybką zmianę w repozytorium?
- Kontenery deweloperskie (ADR-0106): folder po stronie kontenera czy maszyny?

## Zastępuje i rozszerza
- Zawęża ADR-0057: folder ma zapis rozmowy i pliki hosta; reszta decyzji zostaje.
- Rozszerza ADR-0095 (zasięg wątku) i ADR-0093 (agent rozmowy w folderze).

## Implikacje dla kodu
Decyzję będą egzekwować MT-CODE-002 i MT-CODE-003 (zapis wątku folderu to wersjonowany dokument), MT-TEST-001 (e2e: czat folderu startuje w folderze i uruchamia run w repozytorium) i MT-TEST-003. Kod zmienia się dopiero po akceptacji tej decyzji; dotknie ona:

- `packages/core/src/application/threads.ts`, `panes.ts`: wątek i panel bez repozytorium, katalog pracy panelu w folderze.
- `packages/cli/src/serve/server.ts`, `serve/routes/threads.ts`, `serve/routes/panes.ts`: wątki i panele folderu; `FOLDER_COMMANDS`.
- Generator plików hosta (`metator/agents/mt-chat.md` z sekcją folderu), `metator repos setup`, `metator update`.
- `packages/desktop/src/features/threads/chat-actions.ts`, `app/sidebar/sidebar.tsx`: „+ New chat” w folderze, menu z repozytoriami, oznaczenie wiersza wątku.
- `site/guide/many.md`, `site/many/index.md`.
