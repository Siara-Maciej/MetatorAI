# ADR-0106: Dev Containers: aplikacja na Windows (albo macOS) jest tylko oknem, wszystko inne działa w kontenerze deweloperskim

- Status: Accepted
- Data: 2026-11-23

## Kontekst
Właściciel (runda 21): „Moje repozytorium jest w Dev Containerze (rozszerzenie Dev Containers w VS Code). Aplikację instaluję na Windows. Czy mogę dodać repozytorium z kontenera, tak jak rozszerzenie VS Code pozwala przeglądać jego kod? Każdy skrypt CLI i każdy proces ma działać w kontenerze; na Windows mam tylko wyświetlanie". Kontener uruchamia Rancher Desktop, ale ma działać też Docker Desktop. VS Code nie zawsze jest otwarte, więc nic nie może zależeć od tego, że VS Code przekazuje port. Właściciel wybrał pełną integrację (wariant 2).

Runda 20 (ADR-0105) przygotowała grunt: aplikacje na Windows i macOS niosą przenośną paczkę CLI dla Linuksa (`linux-cli/<arch>/`, tarball i manifest `LinuxCliBundle`) i komendę Tauri `linux_cli_bundle(arch)`.

## Decyzja
### 1. Dostęp do silnika kontenerów: CLI osoby, port i dwa adaptery
- Aplikacja rozmawia z kontenerami przez **program, który osoba już ma**: `docker` (Docker Desktop; Rancher Desktop z silnikiem dockerd/moby), a gdy jego silnik nie odpowiada, `nerdctl` (Rancher Desktop z containerd). Silnik „odpowiada", gdy `<program> info --format '{{.ServerVersion}}'` zwraca wersję. Bieżący kontekst dockera (`rancher-desktop`, `desktop-linux`) obowiązuje sam, bo to zwykłe wywołanie `docker`; aplikacja tylko go pokazuje (`docker context show`). Żadnego SDK, żadnego gniazda.
- Port **`ContainerEngine`** w `@metator/core` (pięć członków: `list(label)`, `inspect(ids)`, `start(id)`, `exec(id, command)`, `copyIn(id, file)`) ma dwa adaptery w `@metator/plugin-docker`: `DockerCliEngine` i `NerdctlCliEngine`. Oba mówią tymi samymi słowami (`ps -a -q --filter label=…`, `inspect`, `start`, `exec -u -w -e`); `inspect` czytany jest w kształcie dockera i nerdctl (nazwa z „/" albo bez, obraz w `Config.Image` albo obok). Plik trafia do kontenera przez `exec -i … sh -c 'cat > "$1"'`, więc należy do użytkownika i działa tak samo w obu CLI (`nerdctl cp` nie czyta ze standardowego wejścia tak jak `docker cp -`).
- **Wspólny zestaw kontraktowy** (`containerEngineContract`, `packages/testing`) przechodzi na obu adapterach z zastępczym CLI (`standInContainerCli`: skrypt Buna `docker` albo `nerdctl`, który odpowiada w dialekcie swojego programu i wykonuje `exec` na tej maszynie).
- **Adaptery działają po stronie hosta w CLI aplikacji, nie w Ruście.** Aplikacja i tak niesie `metator` na swoją platformę (ADR-0105) i uruchamia go dla każdej komendy. Logika (etykiety, montowania, użytkownik, sonda, decyzja o instalacji, linki edytora) jest w czystych funkcjach domeny z testami i mutantami, port ma zestaw kontraktowy, a ta sama komenda służy też osobie w terminalu: `metator devcontainer list|start|install|run|exec|serve`. W powłoce Tauri zostaje tylko to, co musi żyć razem z oknem: przekaźnik pętli zwrotnej (pkt 5) i lista repozytoriów.

### 2. Znajdowanie kontenerów deweloperskich
- Kontener deweloperski to kontener z etykietą `devcontainer.local_folder` (ustawia ją rozszerzenie Dev Containers i `devcontainer` CLI), także zatrzymany; obok `devcontainer.config_file` i `devcontainer.metadata` (JSON: jeden obiekt na feature i konfigurację).
- Lista pokazuje nazwę folderu lokalnego, stan (`running`/`stopped`), folder roboczy w kontenerze, użytkownika i link edytora. **Folder roboczy** to cel montowania typu bind, którego źródłem jest folder lokalny (albo folder nad nim, wtedy z resztą ścieżki). Źródło porównywane jest po sprowadzeniu do jednego klucza, bo silniki mówią o folderze Windows po swojemu: `c:\Users\me\shop`, `/run/desktop/mnt/host/c/Users/me/shop` (Docker Desktop, WSL 2), `/host_mnt/c/...`, `/mnt/c/...` (Rancher Desktop), udział `\\wsl.localhost\<dystrybucja>\...`; ścieżka z literą dysku bez rozróżniania wielkości liter. Inaczej montowanie folderu o tej samej nazwie, inaczej pierwsze pod `/workspaces`, inaczej brak (wiersza nie da się wybrać).
- Zatrzymany kontener można uruchomić („Start", `metator devcontainer start`). Kontenera, którego jeszcze nie ma, aplikacja nie tworzy: mówi „otwórz go raz w VS Code albo uruchom `devcontainer up`".

### 3. Instalacja CLI w kontenerze
- **Sonda** (jedno `exec` jako użytkownik zdalny, `sh -c`) mówi: `uname -m`, użytkownika, katalog domowy, `PATH` powłoki logowania (jak pyta VS Code: powłoka logowania interaktywna, najwyżej 5 s), glibc albo musl, czy są `tar` i `gzip`, i każdą zainstalowaną wersję CLI z jej znacznikiem.
- **Architektura** z `uname -m` (`x86_64`/`amd64` → x64, `aarch64`/`arm64` → arm64) wybiera paczkę z `linux-cli/<arch>/`. Kontener musl (Alpine), inna architektura, glibc starszy niż w manifeście albo brak `tar` są odrzucane z powodem (`MUSL`, `UNSUPPORTED`), zanim cokolwiek zostanie skopiowane.
- **Kontrola wersji**: paczka jest kopiowana, gdy `~/.metator/server/<wersja>/.installed` nie zawiera SHA-256 jej tarballa. Kopia idzie do `~/.metator/server/<wersja>.incoming.tar.gz`, skrypt sprawdza SHA-256 (`sha256sum`), rozpakowuje obok, przenosi na miejsce, a znacznik pisze na końcu, z `umask 022` (silnik może mieć inny umask). Na koniec CLI jest uruchamiane raz (`version`), więc kontener, w którym nie ruszy, mówi to od razu.
- Tylko ten folder użytkownika i repozytorium. **Nic nie dotyka `PATH` osoby** ani jej plików; stare wersje zostają, aż osoba je usunie.

### 4. Demon w kontenerze
- `metator devcontainer serve <kontener> --path <repozytorium>` uruchamia w kontenerze `metator -C <repozytorium> serve --ensure --port 0` (po instalacji, jeśli trzeba) **jako użytkownik zdalny** (`remoteUser`, inaczej `containerUser` z metadanych, inaczej użytkownik obrazu, inaczej root).
- Każdy proces dostaje środowisko, jakie ma terminal kontenera: `HOME`, `USER`, `PATH` powłoki logowania, `remoteEnv` z metadanych (z podstawionym `${containerEnv:NAZWA}`; zmienne znane tylko hostowi, `${localEnv:…}`, są pomijane) i `METATOR_IN_DEVCONTAINER=1`. Skompilowane CLI samo stawia swój folder na początku `PATH` (ADR-0105), więc demon, git, hooki i sesje Claude Code / Copilot działają w kontenerze i znajdują `metator`.
- `metator setup` w kontenerze to ten sam przepływ „Add repository" przez `exec` (`devcontainer run <kontener> -- inspect|setup|setup --commit`). `inspect` w kontenerze mówi przy każdym hoście i przy gicie, jak je dodać (`fix`): linię feature do `devcontainer.json` (Claude Code: `ghcr.io/anthropics/devcontainer-features/claude-code:1`; git: `ghcr.io/devcontainers/features/git:1`) albo komendę do terminala kontenera (Copilot CLI: `npm install -g @github/copilot`).

### 5. Okno i demon: tunel stdio
- Aplikacja otwiera port pętli zwrotnej na hoście i **każde połączenie** łączy ze świeżym `<docker|nerdctl> exec -i -u <użytkownik> <kontener> <launcher> tunnel --port <port demona>`; komendę podaje `devcontainer serve`. `metator tunnel --port <n>` (podkomenda paczki) łączy stdin i stdout z `127.0.0.1:<n>` w kontenerze, bajt w bajt. HTTP i WebSockety przechodzą tak samo.
- Demon słucha dalej na 127.0.0.1 w kontenerze. **Bez publikowanego portu, bez 0.0.0.0, bez VS Code.**
- Koniec stdin kończy połączenie dopiero, gdy demon milczy 2 s: serwer, który widzi półzamknięte połączenie, porzuca pisaną odpowiedź (Bun tak robi), a przeglądarka, która odeszła, i tak nic już nie wysyła.
- Przekaźnik jest w powłoce Tauri (Rust, biblioteka standardowa): wątek na połączenie, port stały dla repozytorium, dopóki działa aplikacja; ponowne otwarcie (Reconnect) kieruje nowe połączenia na aktualny identyfikator kontenera i port demona. Zatrzymany kontener kończy połączenie od razu (exec się nie udaje), a `devcontainer serve` mówi `CONTAINER_STOPPED`: okno pokazuje „kontener się zatrzymał" ze Start/Reconnect.

### 6. Linki edytora
- „Otwórz w edytorze" dla repozytorium w kontenerze otwiera VS Code na hoście, dołączone do kontenera: `vscode://vscode-remote/dev-container+<hex>/<ścieżka w kontenerze>:<linia>`. `<hex>` to bajty UTF-8 folderu lokalnego (domyślna konfiguracja: `.devcontainer/devcontainer.json` albo `.devcontainer.json`), a dla innej konfiguracji JSON `{"hostPath", "configFile": {"$mid":1, "path", "scheme":"vscode-fileHost"}}` w hex, jak koduje go rozszerzenie. Edytor w kontenerze nigdy nie jest domyślny. `open_uri` otwiera tylko linki `vscode://` i `vscode-insiders://`.

### 7. Hosty w kontenerze
Claude Code / Copilot CLI i git muszą być zainstalowane i zalogowane w kontenerze. Aplikacja sprawdza je tam (`inspect` w kontenerze) i mówi, jak je dodać (pkt 4).

### 8. Lista repozytoriów aplikacji
- Wpis `repos.json` (`DesktopRepos`, nadal `schemaVersion: 1`: nowy rodzaj i pole są addytywne, starsza aplikacja je pomija) dostaje `kind: "devcontainer"` i `devcontainer: { localFolder, workspaceFolder, configFile, editorUri }`. Kluczem (`path`) jest `devcontainer:<folder lokalny>`: etykieta przetrwa przebudowę kontenera, a identyfikator kontenera jest wyszukiwany przy każdym połączeniu. Ten sam folder dodany jako repozytorium na tym komputerze pozostaje osobnym wpisem.
- Przełącznik pokazuje taki wpis jako „shop (Dev Container)"; „Add repository" ma trzecie źródło, **„Dev Container"**, z listą znalezionych kontenerów.

### Komendy powłoki Tauri (kontrakt z UI)
`list_devcontainers`, `start_devcontainer`, `install_in_container` (zdarzenia `container://install-output`, `container://install-done`), `open_uri`; `inspect_folder`, `run_setup`, `git_init`, `commit_setup` i `add_repo` z opcjonalnym `container`; `open_repo` z kluczem kontenera. Powód z CLI (`details.reason`) staje się kodem odmowy: `NO_ENGINE`, `CONTAINER_MISSING`, `CONTAINER_STOPPED`, `MUSL`, `UNSUPPORTED`.

### Nowe zależności
Brak: ani pakietów npm, ani crate'ów Rusta. Przekaźnik używa biblioteki standardowej Rusta; `open_uri` używa `tauri-plugin-shell` (już zależnością, ADR-0078).

## Konsekwencje
### Pozytywne
- Na Windows działa tylko okno; demon, git, hooki i sesje AI działają w kontenerze, jako jego użytkownik, z jego środowiskiem.
- Docker Desktop i Rancher Desktop (oba silniki) przez ten sam port; bieżący kontekst dockera obowiązuje sam.
- Nic nie zależy od VS Code: ani przekazywanie portu, ani jego serwer.
- To samo z terminala: `metator devcontainer …` na Linuksie i macOS.

### Negatywne
- Każde połączenie okna to jedno `docker exec` (na tej maszynie ok. 0,4 s na pierwszą odpowiedź); WebView trzyma połączenia keep-alive, więc koszt płaci się rzadko.
- Instalacja kopiuje ok. 57 MB na wersję i użytkownika; stare wersje zostają w `~/.metator/server/`.
- Link `vscode-remote` dla konfiguracji innej niż domyślna i zachowanie Windows (Docker Desktop, Rancher Desktop z moby i z containerd, ścieżki WSL) sprawdzi dopiero właściciel (lista w `site/guide/devcontainers.md`).
- Demon uruchomiony przez starszą wersję CLI w kontenerze jest używany dalej, dopóki działa (`serve --ensure`).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Adaptery w Ruście w powłoce Tauri | logika poza portami, kontraktami i mutantami repozytorium; nie służyłaby terminalowi |
| Docker SDK / gniazdo silnika | inne dla Dockera, Ranchera i containerd; osoba ma już CLI z właściwym kontekstem |
| Publikowany port albo 0.0.0.0 w kontenerze | demon wystawiony na sieć; zmiana konfiguracji kontenera osoby |
| Przekazywanie portu przez VS Code | VS Code nie zawsze jest otwarte |
| `docker cp` paczki | pliki należą do roota; `nerdctl cp` nie czyta ze stdin |
| Jeden długi `exec` z multipleksowaniem połączeń | własny protokół do utrzymania; połączenie = proces jest prostsze i odporne na restart demona |
| Instalacja w `/usr/local` albo dopisanie do `PATH` | zmienia pliki obrazu i środowisko osoby; folder użytkownika jak serwer VS Code |

## Implikacje dla kodu
- `packages/core/src/domain/devcontainer.ts` (etykiety, montowania, użytkownik, `remoteEnv`, sonda, kontrola wersji, link edytora, wybór silnika), `packages/core/src/application/devcontainers.ts` (`DevContainers`), port `ContainerEngine`.
- `packages/plugin-docker/src/cli-container-engine.ts` (`DockerCliEngine`, `NerdctlCliEngine`, `engineFacts`); `packages/testing/src/contracts/container-engine.contract.ts`, `stand-in-container-cli.ts`.
- `packages/runtime/src/devcontainers.ts`; `packages/cli/src/commands/devcontainer.ts`, `commands/tunnel.ts`, `tunnel.ts`; `inspect` z `fix` (`InspectFolder.inContainer`).
- `packages/desktop/src-tauri/src/devcontainer.rs`, `forward.rs`, `store.rs`, `envelope.rs`, `lib.rs`, `examples/forward.rs`.
- e2e: `e2e/devcontainer.e2e.test.ts` (zastępczy silnik, zawsze) i `e2e/devcontainer-docker.e2e.test.ts` (prawdziwy docker i kontener `devcontainers/base:bookworm`, gdy podano `METATOR_E2E_DOCKER_BUNDLES`); ten drugi uruchamia job `devcontainer` w `desktop.yml` na paczce x64 z joba `linux-cli`, a `release` na niego czeka.
- Przykład `cargo run --example forward -- <komenda tunelu>`: sam przekaźnik aplikacji, do dowodu na prawdziwym kontenerze (`METATOR_E2E_FORWARD_BIN`).
