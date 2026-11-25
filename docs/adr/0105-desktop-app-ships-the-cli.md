# ADR-0105: Aplikacja desktopowa to wszystko, co osoba instaluje: CLI w środku, „Add repository" i przenośna paczka CLI dla Linuksa

- Status: Accepted
- Data: 2026-11-23

## Kontekst
Do tej pory aplikacja (ADR-0078, ADR-0101) była cienkim klientem nad `metator`, który osoba instalowała osobno z npm, a konfigurację repozytorium robiła w terminalu (`metator setup`). Decyzja właściciela (runda 20): „chcę zacząć setup w repozytorium z aplikacji, wskazując jego ścieżkę, żeby nie instalować niczego z npm; z aplikacją robię wszystko. Jakaś opcja Add repository". Aplikacja nie zainstaluje tylko gita i CLI hosta AI (Claude Code `claude` albo GitHub Copilot CLI `copilot`, zainstalowanego i zalogowanego): sprawdza je i mówi, jak je zainstalować.

ADR-0101 zapowiedział binarkę `metator` dołączoną do paczki. `bun build --compile` robi z `packages/cli/src/main.ts` jeden plik wykonywalny (ok. 118 MB, ok. 2 s), ale ten plik nie startuje: dodatki natywne (`.node`) nie mieszczą się w nim i nie ma przy nim `node_modules`.

Właściciel dołożył w tej rundzie wymóg na następną: Dev Containers. Aplikacja na Windows znajdzie kontenery deweloperskie osoby przez `docker` albo `nerdctl` (Docker Desktop, Rancher Desktop), skopiuje do kontenera linuksowe CLI i uruchomi w nim demona. Ta runda robi na to miejsce: paczkę CLI dla Linuksa i sposób, by aplikacja ją znalazła; samej obsługi Dev Containers nie robi.

## Decyzja
### 1. CLI jest w aplikacji
- **Każdy build aplikacji kompiluje CLI na swoją platformę** (`scripts/compile-cli.ts --triple <triple Rusta>`): plik `binaries/metator-<triple>` to sidecar Tauri (`bundle.externalBin`), a obok niego folder zasobów `metator-resources/` (`bundle.resources`). Uniwersalna aplikacja macOS dostaje binarkę z `lipo` i dodatki obu architektur (`bun install --cpu='*'`).
- **Układ `metator-resources/`**: `native/<platform>-<arch>/oxc-parser.node` i `oxc-resolver.node`, `node-pty/` (pakiet: na Uniksie natywny build, na Windows także JavaScript i programy ConPTY), `sandbox-runtime/` (`srt` złożony w jeden plik i jego programy), `canon/` (agenci, skille, workflowy, reguły, które instaluje `setup`). Skompilowany `metator` znajduje ten folder sam (`packages/cli/src/installation.ts`): `$METATOR_RESOURCES`, inaczej obok siebie, w `../Resources/` (macOS) albo w `../lib/MetatorAI/` (`.deb`, AppImage). Przy starcie dopisuje do swojego środowiska `METATOR_RESOURCES`, `METATOR_CANON` i swój folder na początek `PATH`, więc każdy proces, który uruchamia (demon, drive, sesja hosta, hooki w niej), znajduje tę samą instalację, a zwykłe `metator` w hooku to on. Uruchomiony z checkoutu albo z npm nie zmienia niczego.
- **Każdy dodatek ma swoją drogę, sprawdzoną na skompilowanej binarce:**

  | Dodatek | Droga | Dlaczego |
  |---------|-------|----------|
  | `oxc-parser`, `oxc-resolver` (napi-rs) | Wtyczka bundlera w `compile-cli.ts` przepisuje ich loader: `requireNative()` zwraca `nativeAddon("<pakiet>")`, które ładuje `.node` z `metator-resources/native/<platform>-<arch>/`. Brak pliku nie zatrzymuje programu: dostaje zastępnik, którego każde użycie rzuca błąd z przyczyną i naprawą, więc pada tylko komenda, która parsuje. Loader bez `requireNative()` (nowa wersja pakietu) zatrzymuje build. | `NAPI_RS_NATIVE_LIBRARY_PATH` to jedna zmienna dla obu dodatków, a są dwa różne pliki; musiałaby też być ustawiona przed startem procesu. Loadery napi-rs wybierają plik w czasie działania (nazwy zależne od platformy w `try`/`catch`), czego bundler nie śledzi. |
  | `node-pty` | Na Uniksie nasz `NodePtyTerminal` ładuje `pty.node` sam; folder pakietu przychodzi z instalacji (`metator-resources/node-pty`, `build/Release` albo `prebuilds/<platform>-<arch>`). Na Windows ładuje JavaScript node-pty z tego folderu (ConPTY), a na czas `kill` ustawia `BUN_BE_BUN=1`, bo node-pty uruchamia wtedy skrypt pomocniczy programem `process.execPath`. | `createRequire` z jawnej ścieżki działa w skompilowanym pliku; node-pty nie ma prebuildów dla Linuksa, więc build z `bun install` na danej maszynie. |
  | `srt` (`@anthropic-ai/sandbox-runtime`, ADR-0104) | `Bun.build` składa go w jeden plik `sandbox-runtime/dist/cli.js` z programami, które dostarcza (seccomp na Linuksie). Uruchamia go sam `metator` jako `bun`: `env BUN_BE_BUN=1 <metator> cli.js …`; sesja w środku dostaje `env -u BUN_BE_BUN`, żeby jej `metator` był znowu `metatorem`. Brak runtime'u przy włączonym sandboxie to ostrzeżenie `isolation` w `metator doctor` ze ścieżką, gdzie szukał, a nie cichy błąd. | `process.execPath` skompilowanego pliku to `metator`, nie `bun`; `BUN_BE_BUN` to przełącznik Buna, który robi z niego `bun`. |
  | Claude Code z Agent SDK | SDK nosi własne Claude Code w pakiecie platformowym, którego skompilowany plik nie ma: `metator` wskazuje mu `claude` osoby (`METATOR_CLAUDE_EXECUTABLE`, `pathToClaudeCodeExecutable`). | Osoba i tak musi mieć zainstalowane `claude` do sesji interaktywnej. |
  | reguły `rules/conformance` (`bun test`) | `process.execPath test …` z `BUN_BE_BUN=1`. | j.w. |

  Inne `.node` w `node_modules` (`rollup`, `@napi-rs/lzma`, `@tauri-apps/cli`) są narzędziami budowania, nie CLI; `ast-grep`, `biome`, `tsc` są programami repozytorium, które CLI uruchamia, nie ładuje.
- **Aplikacja używa najpierw dołączonego CLI.** `metator` z `PATH` albo wskazany program tylko wtedy, gdy osoba wybrała to w Ustawieniach (deweloper z checkoutu); `$METATOR_BIN` wygrywa jak dotąd. Build bez sidecara (deweloperski) bierze `metator` z `PATH`.

### 2. Hooki i agenci znajdują `metator` bez ruszania `PATH` osoby
- Każdy proces, który uruchamia aplikacja, dostaje `PATH`: folder używanego CLI, potem `PATH` powłoki logowania (aplikacja z ikony nie ma `PATH` terminala, gdzie zwykle są `git`, `claude`, `copilot`), potem własny. Sesje hostów dziedziczą go od demona. Pliki hooków w repozytorium wołają zwykłe `metator`.
- `claude` uruchomiony ręcznie poza aplikacją tego nie dostaje. Ustawienia mają **„Install the metator command"** (jak „Install 'code' command in PATH" w VS Code): dopiero na kliknięcie aplikacja pisze mały launcher (`~/.local/bin/metator` na Linuksie i macOS; na Windows `metator.cmd` w `%LOCALAPPDATA%\MetatorAI\bin`, dopisany do `PATH` użytkownika). Launcher nosi znacznik: aplikacja nadpisuje i usuwa tylko swój, nigdy cudzego `metator`. AppImage odmawia (jego pliki zmieniają miejsce przy każdym starcie).

### 3. „Add repository"
- **`metator inspect [path]`** (tylko odczyt, deterministyczne): repozytorium (worktree liczy się jako jego repozytorium) albo folder repozytoriów, czy jest skonfigurowane (`yes`, `no`, `newer`: konfiguracja z nowszego MetatorAI), niezacommitowane pliki, git, hosty w kolejności `supervisor.hostOrder` (zainstalowany, ślad logowania, jak zainstalować i zalogować), domyślny host, pliki, które zapisze `setup` dla każdego hosta (podgląd: setup w folderze tymczasowym, z `.gitignore` repozytorium), i co aplikacja proponuje dalej (`next`).
- **`setup` mówi, co zapisał** (`written`), a **`metator setup --commit --files <pliki…>`** commituje dokładnie te pliki jako „Set up MetatorAI", i nic innego. Commit zawsze jest decyzją osoby (przycisk Commit).
- **Komendy powłoki Tauri** (kontrakt z UI; każda odmowa to `{ code, message, hint }`): `pick_folder` (tauri-plugin-dialog), `inspect_folder`, `run_setup` (zdarzenia `setup://output`, `setup://done`), `git_init`, `commit_setup`, `known_repos`, `add_repo`, `remove_repo`, `open_repo` (`serve --ensure`), `ensure_daemon` (dawna nazwa), `cli_info`, `set_cli_source`, `install_cli_command`, `uninstall_cli_command`, `linux_cli_bundle`.
- **Aplikacja pamięta repozytoria i ustawienia** w swoim folderze danych: `repos.json` (`kind: DesktopRepos`) i `settings.json` (`kind: DesktopSettings`), dokumenty wersjonowane (ADR-0016); plik z nowszej aplikacji jest odrzucany, nigdy nadpisany. „Remove from the app" zapomina repozytorium; plików nie usuwa.

### 4. Wersja przeglądarkowa
Nie ma wybieraka folderów ani procesów: ekran Add repository pokazuje pole ścieżki i komendy do wpisania, i mówi, że aplikacja robi to sama.

### 5. Aktualizacje
Dołączone CLI i aplikacja mają jedną wersję. Konfiguracja nowsza, niż rozumie CLI (`setUp: newer`, `next: update-app`), to prośba o aktualizację aplikacji; plików nie obniżamy.

### 6. Przenośna paczka CLI dla Linuksa (pod Dev Containers)
- **Paczka** (`scripts/linux-cli-bundle.ts`, `packages/cli/src/linux-bundle.ts`) to jeden tarball na architekturę, `metator-linux-<arch>.tar.gz` (x64 i arm64):
  ```
  metator-linux-<arch>/
    bin/metator                  launcher (POSIX sh)
    libexec/metator              skompilowany plik
    libexec/metator-resources/   dodatki, node-pty, srt, kanon
  ```
  Obok leży manifest `metator-bundle.json` (`kind: LinuxCliBundle`, `schemaVersion: 1`): wersja, architektura, `libc: glibc`, najstarszy glibc, na którym działa, nazwa tarballa, launcher (`entry`) i SHA-256 tarballa.
- **Tarball, nie folder**: aplikacja na Windows nie zachowa bitów wykonywalności w swoim folderze, a tarball tak; `docker cp - <kontener>:<ścieżka>` przyjmuje go ze standardowego wejścia i rozpakowuje w kontenerze bez `tar` w obrazie.
- **Launcher** znajduje paczkę po swojej ścieżce (także przez dowiązanie, np. z `/usr/local/bin`), ustawia `METATOR_RESOURCES` i uruchamia plik. Wcześniej mówi wprost i kończy kodem 126, gdy maszyna go nie uruchomi: inna architektura, brak glibc (Alpine i inne systemy musl nie są obsługiwane), glibc starszy niż potrzebny (`getconf GNU_LIBC_VERSION`).
- **Najstarszy glibc jest mierzony**, nie zgadywany: najnowsza wersja symbolu `GLIBC_x.y`, o którą proszą programy i dodatki paczki (`objdump -T`). Wiąże go `pty.node`: zbudowany na glibc 2.34+ wymaga 2.34 (`forkpty`, `openpty`). Dlatego CI buduje paczkę w kontenerze `debian:bullseye` (glibc 2.31), każdą architekturę na maszynie tej architektury (`ubuntu-22.04`, `ubuntu-22.04-arm`): node-pty buduje `bun install`.
- **CI** (`desktop.yml`): job `linux-cli` buduje paczkę raz na architekturę i sprawdza ją e2e (rozpakowana w świeżym folderze, czyste środowisko); buildy Windows i macOS pobierają oba artefakty do `src-tauri/linux-cli/<arch>/` i pakują je do zasobów aplikacji (`tauri.linux-cli.conf.json`). Brak pliku zatrzymuje build z nazwą pliku.
- **Komenda Tauri `linux_cli_bundle(arch)`** → `{ path, version, arch, entry, sha256, glibc }`; przyjmuje nazwy Node'a, Dockera i `uname -m` (`x64`, `amd64`, `x86_64`, `arm64`, `aarch64`). Build linuksowy aplikacji paczki nie nosi (`NOT_FOUND` z podpowiedzią).

### Nowe zależności
- Bez nowych pakietów npm.
- Crate'y Rusta powłoki: `tauri-plugin-dialog` (natywny wybierak folderu), `serde` i `serde_json` (koperta CLI, pliki aplikacji, manifest paczki).

## Konsekwencje
### Pozytywne
- Osoba instaluje aplikację, git i CLI hosta; nic z npm. Setup, commit i start demona są w aplikacji.
- Jedna wersja CLI i aplikacji; hooki zawsze trafiają w to CLI, z którego korzysta aplikacja.
- Paczka linuksowa jest sprawdzona w e2e tak, jak ją dostanie kontener, i gotowa dla następnej rundy.

### Negatywne
- Instalator rośnie: binarka ok. 118 MB na platformę (macOS uniwersalny: dwie), do tego dwie paczki linuksowe po ok. 57 MB w buildach Windows i macOS.
- Wtyczka bundlera zależy od kształtu loaderów napi-rs; nowa wersja oxc może wymagać zmiany skryptu (build wtedy staje, a nie wypuszcza CLI, które nie parsuje).
- Windows (ConPTY z node-pty w skompilowanym pliku, launcher `.cmd`, `PATH` użytkownika) i macOS (`spawn-helper`, podpis, uniwersalna binarka) sprawdzi dopiero CI i ręczna próba po scaleniu.
- Paczka linuksowa nie działa na musl (Alpine) ani na glibc starszym niż zmierzony.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| `NAPI_RS_NATIVE_LIBRARY_PATH` dla oxc | jedna zmienna na dwa różne dodatki; musiałaby być ustawiona przed startem procesu |
| Instalacja CLI z npm przez aplikację | wymaga Node/Bun u osoby; właściciel chce niczego z npm |
| Aplikacja dopisuje swój folder do `PATH` sama przy instalacji | zmiana środowiska bez kliknięcia osoby; launcher na żądanie jak w VS Code |
| Paczka linuksowa jako folder w zasobach aplikacji | Windows gubi bity wykonywalności; tarball je niesie |
| Paczka statyczna (musl) | node-pty i dodatki oxc są budowane na glibc; Dev Containers to w praktyce obrazy glibc (Debian, Ubuntu) |
| Cross-kompilacja arm64 na x64 | node-pty nie ma prebuildu dla Linuksa; build na maszynie arm64 jest prostszy i sprawdza paczkę na niej |

## Implikacje dla kodu
- Reguły kanonu: logika w czystych funkcjach z testami (MT-ARCH-001, MT-TEST-001), procesy tylko w adapterach (MT-ARCH-005), dokumenty wersjonowane (MT-CODE-003, ADR-0016), mutanty (MT-TEST-003).
- `packages/cli/src/installation.ts`, `packages/cli/src/linux-bundle.ts`, `scripts/compile-cli.ts`, `scripts/linux-cli-bundle.ts`.
- `packages/core/src/domain/inspection.ts`, `packages/core/src/application/inspect-folder.ts` (`InspectFolder`, `CommitSetup`), port `RepositoryGit`, `packages/plugin-git/src/git-cli-repository.ts`, `packages/runtime/src/inspect.ts`, `packages/cli/src/commands/setup.ts`.
- `packages/plugin-node/src/node-pty-terminal.ts`, `srt-sandbox.ts`; `packages/core/src/domain/sandbox.ts` (`isolation`).
- `packages/desktop/src-tauri/src/*.rs`, `tauri.bundle.conf.json`, `tauri.linux-cli.conf.json`, `.github/workflows/desktop.yml`.
- e2e: `e2e/inspect.e2e.test.ts`, `e2e/linux-cli-bundle.e2e.test.ts`.
