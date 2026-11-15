# ADR-0087: Aplikacja sama uruchamia demona (`metator serve --ensure`)

- Status: Proposed
- Data: 2026-11-15

## Kontekst
[ADR-0078](0078-desktop-app-tauri-xterm.md) zrobił z aplikacji cienkiego klienta nad `metator serve`: aplikacja tylko rysuje, a demona startuje osoba w terminalu. Gdy demon nie działa, każdy ekran pokazuje panel „no daemon" z komendą do wpisania. Decyzja właściciela z 2026-11-15: włączam samą aplikację i działa, bez `metator serve` z ręki.

Decyzje właściciela do tego ADR (2026-11-15):
1. Demon uruchomiony przez aplikację serwuje **ostatnio otwarty folder**; przy pierwszym starcie folder wybiera się w aplikacji.
2. Program `metator` aplikacja bierze z **binarki dołączonej do paczki**, a zapasowo z `PATH`.
3. Po zamknięciu aplikacji demon **działa dalej, dopóki są aktywne sesje** (terminale agentów żyją w demonie); bez aktywnych sesji kończy się z aplikacją.

## Decyzja
- **Logika w CLI, nie w powłoce Tauri.** `metator serve --ensure` odpowiada adresem demona, który serwuje repozytorium (lub folder repozytoriów): gdy żyje (`.metator/daemon.json` wskazuje żywy proces), zwraca go z `started: false`; gdy nie, startuje `metator serve` z tymi samymi opcjami jako proces odłączony (port `BackgroundProcess`, log w `.metator/daemon.log`), czeka, aż plik demona wskaże żywy proces (`--timeout`, domyślnie 20 s) i zwraca `started: true`. Drugi demon dla tego samego katalogu nie powstaje.
- **Powłoka Tauri** przy starcie (i z panelu „no daemon") woła `metator -C <folder> serve --ensure --port 0` i przekazuje oknu zwrócony adres. Aplikacja dalej nie ma logiki domenowej: nie zna runów, tylko pyta o adres.
- **Folder:** zapamiętany w ustawieniach aplikacji; gdy go nie ma, aplikacja o niego pyta. W przeglądarce (bez powłoki) nic się nie zmienia: panel „no daemon" i `?daemon=`.
- **Program:** najpierw `METATOR_BIN`, potem binarka z paczki, potem `metator` z `PATH` (na macOS i Linuksie przez powłokę logowania, bo aplikacja z ikony nie dziedziczy `PATH` terminala).
- **Czas życia:** proces demona jest odłączony od aplikacji. Zamknięcie z aplikacją przy braku aktywnych sesji to osobny krok (wymaga pytania demona o aktywne sesje przy zamykaniu okna).

## Stan realizacji
- Zrobione: `serve --ensure` w CLI z testami jednostkowymi (`packages/cli/test/ensure-daemon.test.ts`) i e2e na prawdziwym demonie (`e2e/serve-ensure.e2e.test.ts`).
- Otwarte: wywołanie z powłoki Tauri i z panelu aplikacji; binarka w paczce (zależy od pakowania F8.8 i od tego, czy `node-pty` działa w skompilowanym programie); zamykanie demona z aplikacją.

## Konsekwencje
### Pozytywne
- Jedno miejsce z logiką startu, sprawdzalne testem na prawdziwym procesie; powłoka Tauri to kilkanaście linii.
- Ta sama komenda służy skryptom i innym frontom (`metator ui`).

### Negatywne
- Powłoka Tauri uruchamia proces: zmiana względem ADR-0078 („aplikacja tylko rysuje").
- Demon odłączony może zostać po zamknięciu aplikacji, dopóki nie powstanie krok zamykania.
- Budowy powłoki Tauri nie da się sprawdzić bez WebKitGTK/WebView2; weryfikuje ją workflow `desktop`.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Start demona napisany w Ruście | logika poza testami e2e repozytorium, druga implementacja wykrywania żywego demona |
| Demon jako proces potomny okna | zamknięcie okna zabijałoby terminale agentów w trakcie pracy |
| Usługa systemowa (launchd, systemd, usługa Windows) | instalacja wymaga uprawnień i trzech osobnych implementacji |

## Implikacje dla kodu
- `packages/cli/src/serve/ensure.ts`, `packages/cli/src/commands/serve.ts` (`--ensure`, `--timeout`).
- `packages/desktop/src-tauri` i panel „no daemon" (otwarte).
