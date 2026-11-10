# ADR-0078: Aplikacja desktopowa: Tauri, React i xterm.js jako cienki klient demona

- Status: Proposed
- Data: 2026-11-02

## Kontekst
Specyfikacja [design/12](../design/12-desktop.md) (decyzja 8) zamawia aplikację desktopową jako cienki klient nad `metator serve`: cała logika w demonie, aplikacja tylko rysuje. Ekrany (skrzynka decyzji, sesja z terminalem, siatka terminali, graf, supervisor, odprawa, nowa sesja) wymagają prawdziwego emulatora terminala nad PTY demona, powiadomień systemowych i jednego pakietu na trzy systemy (decyzja 7).

ADR-0010 każe wziąć sprawdzony pakiet zamiast pisać własny. Rozważone:

| Potrzeba | Wybór | Odrzucone |
|---|---|---|
| Okno i powiadomienia na Windows, macOS, Linux | Tauri 2 (`@tauri-apps/api`, `@tauri-apps/cli`, `tauri-plugin-notification`) | Electron: ~100 MB pakietu i własny Chromium dla aplikacji, która jest kilkoma listami i terminalem |
| Terminal nad PTY | `@xterm/xterm` + `@xterm/addon-fit` | własny renderer: parsowanie sekwencji ANSI to lata pracy; `hterm`: nierozwijany |
| Widoki | React 19 przez Vite 7 (`@vitejs/plugin-react`) | Ink (`metator ui`): terminal, nie okno; vanilla DOM: osiem ekranów z współdzielonym panelem sesji potrzebuje komponentów |

## Decyzja
- Pakiet `packages/desktop` (`@metator/desktop`): aplikacja Vite + React w `src/`, powłoka Tauri w `src-tauri/`. Nie importuje `@metator/core` ani żadnego pakietu MetatorAI: zna tylko JSON i WebSockety demona (`src/api.ts`). Kształty odpowiedzi są przepisane do typów klienta; zmiana w demonie to zmiana w obu miejscach, a test e2e (`e2e/desktop.e2e.test.ts`) uruchamia prawdziwy demon, zbudowaną aplikację i Chromium.
- Logika widoku, której nie ma w demonie (kolejność panelu sesji, grupowanie w feature'y, format czasu, routing), to czyste funkcje w `src/model.ts` z testami jednostkowymi i mutantami; komponenty tylko je rysują.
- Demon zyskuje brakujące końcówki (`/workflows`, `/supervisor`, `/report`, `/runs/<id>/brief`, `POST /runs`, `/ws/inbox`) na tych samych use case'ach co CLI; odpowiedź z karty decyzji zapisuje w aktywności `origin: inbox`, z czego liczy się kryterium 11a.
- Adres demona: `?daemon=<url>` albo ustawienie w aplikacji, domyślnie `http://127.0.0.1:4310`.
- Powiadomienia systemowe: wtyczka Tauri w oknie Tauri, Web Notifications w przeglądarce.

## Konsekwencje
### Pozytywne
- Aplikacja da się uruchomić i przetestować w zwykłej przeglądarce (`vite build` + demon), więc CI nie potrzebuje toolchainu Tauri ani WebKitGTK.
- Jedna definicja kształtów API w kliencie: błąd niezgodności wychodzi w e2e, nie u użytkownika.

### Negatywne
- Budowa pakietu Tauri wymaga Rusta i bibliotek systemowych (WebKitGTK na Linuksie); w sandboxie bez nich powłoka Tauri jest tylko sprawdzana statycznie.
- React i Vite to pierwsze zależności frontendowe w repozytorium: osobny `node_modules` pakietu, osobna konfiguracja budowy.

## Implikacje dla kodu
- Nowe końcówki demona z testami e2e; `RunActivity.origin = inbox` przy odpowiedzi z karty (bez zmiany schematu: pole istnieje od v2).
- `packages/desktop/src/model.ts` z testami w `packages/desktop/test` i mutantami w `scripts/mutants.ts`.
