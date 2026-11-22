# ADR-0104: Sandbox obejmuje każdą sesję hosta, którą uruchamia MetatorAI, na obu hostach

- Status: Proposed
- Data: 2026-11-22

## Kontekst
ADR-0102 wprowadził sandbox lokalny tylko dla Claude Code: generator dopisywał blok `sandbox` do `.claude/settings.json`, a Claude Code trzymał w sandboxie swoje komendy powłoki. Copilot CLI nie ma odpowiednika, więc pod Copilotem obowiązywały same hooki. ADR-0098 mówi: funkcji, którą ma tylko jeden host, nie używamy. Decyzja właściciela z 2026-11-22: sandbox trafia do głównej linii dopiero wtedy, gdy działa tak samo na Copilot CLI.

Sandbox Claude Code to biblioteka open source `@anthropic-ai/sandbox-runtime` (Apache-2.0, program `srt`): bubblewrap i `socat` na Linuksie, `sandbox-exec` na macOS, sieć przez własne proxy z listą dozwolonych hostów. Ten sam program potrafi uruchomić dowolny proces, także cały interaktywny CLI hosta.

## Decyzja
- **MetatorAI uruchamia każdą sesję hosta w sandboxie**, gdy repozytorium ma `sandbox.enabled`: Claude Code i Copilot CLI tak samo, czat, konduktor, workerzy, sesje runu, agenci `run drive` (Agent SDK Claude przez `spawnClaudeCodeProcess`, Copilot w trybie `-p`) i sesje zestawu zgodności. Cała sesja hosta, jego komendy, hooki i serwery MCP są w środku.
- **Jedna polityka.** `sandboxPolicy(config)` składa opcje `sandbox.denyRead|allowWrite|allowedDomains`; `sandboxSettings(policy, needs, place)` robi z niej ustawienia `srt` dla jednej sesji: odczyt zamknięty dla `denyRead` i dla plików sekretów repozytorium (`SECRET_GLOBS` guarda, przykłady `.env.example` zostają czytelne), zapis tylko w repozytorium, w katalogu sesji, w katalogu tymczasowym, w stanie maszyny MetatorAI i w plikach stanu hosta; sieć tylko do hostów z listy, do API hosta i do adresu demona (hooki meldują się demonowi przez proxy sandboxa).
- **Każdy host mówi, czego potrzebuje** (`HostDescriptor.sandbox`): Claude Code `api.anthropic.com`, `claude.ai`, `platform.claude.com` (logowanie i odświeżanie tokenu), `mcp-proxy.anthropic.com` (konektory claude.ai), według code.claude.com/docs/en/network-config, oraz `~/.claude`, `~/.claude.json`; Copilot CLI `api.githubcopilot.com`, `*.githubcopilot.com` (host planu, np. `api.individual.githubcopilot.com`), `github.com`, `api.github.com` oraz `~/.copilot`.
- **Polityka jest czytana przy starcie każdej sesji** z konfiguracji repozytorium: włączenie lub wyłączenie działa od następnej sesji, bez restartu demona.
- **Port `HostSandbox`** (rdzeń) i adapter `SrtSandbox` w `plugin-node` (ten pakiet uruchamia procesy w PTY): `srt --settings <plik> -- env METATOR_SANDBOX=1 <argv>`. Plik ustawień jest nazwany skrótem treści, leży w `~/.cache/metator/sandbox`, poza tym, co sesja może zapisać, i jest zapisywany przed każdym startem. `SandboxedTerminal` przekazuje zmianę rozmiaru terminala jako SIGWINCH i zamknięcie jako SIGHUP procesom w sandboxie (bubblewrap zakłada im własną sesję terminala).
- **Klient demona w sandboxie** (`METATOR_SANDBOX=1`) idzie do demona przez proxy sandboxa i nie sprawdza PID demona (inna przestrzeń nazw PID).
- **Blok `sandbox` w `.claude/settings.json` nie jest już pisany**: dwa zagnieżdżone sandboxy bubblewrap się wykluczają. Kod generatora usunięto, a nie ukryto za przełącznikiem: przełącznik, którego nikt nie powinien włączyć, to martwy kod, a blok osoby, jeśli go ma, zostaje nietknięty. Opcja `sandbox.excludedCommands` znika: komenda uruchomiona przez hosta w sandboxie nie może z niego wyjść.
- **`claude` albo `copilot` uruchomiony ręcznie przez osobę, poza MetatorAI, działa bez sandboxa** na obu hostach. Mówi o tym dokumentacja i `metator doctor`.
- **`metator doctor` (`isolation`)**: Linux potrzebuje `bwrap`, `socat` i `rg` (ripgrep: bez niego `srt` nie startuje, bo nim rozwija wzorce `denyRead`), macOS ma `sandbox-exec`, natywny Windows nie ma sandboxa (WSL2 tak).
- **Domyślnie wyłączony**, jak w ADR-0102.
- **Zestaw zgodności** dostaje sprawdzenie `sandbox-deny-read`: w repozytorium zestawu `sandbox.enabled` z katalogiem w `sandbox.denyRead`, nowa sesja czatu, agent robi `cat` pliku z tego katalogu; dowód to odmowa systemu na ekranie, brak treści pliku i hook, który dotarł do demona. Tam, gdzie maszyna nie utrzyma sandboxa, sprawdzenie jest `skipped` z powodem i nie liczy się jako luka hosta.

## Konsekwencje
### Pozytywne
- Ta sama ochrona na obu hostach, także dla procesów potomnych, hooków i serwerów MCP.
- Jedno miejsce z polityką i jedno z uruchamianiem; host dokłada tylko swoje domeny i pliki stanu.

### Negatywne
- Nowa zależność (`@anthropic-ai/sandbox-runtime`, przypięta wersja) i program `rg` na Linuksie.
- Hosty mogą potrzebować więcej, niż wiemy z dokumentacji (pliki stanu, hosty telemetrii); sprawdzą to prawdziwe przebiegi zestawu zgodności u właściciela. W chmurze sprawdzono tylko zastępcze hosty.
- Zapis do `~/.claude.json` idzie przez plik podmontowany w sandboxie; zapis przez zmianę nazwy pliku obok niego się nie uda. Do sprawdzenia na prawdziwym Claude Code.
- `srt` uruchamia się środowiskiem, w którym działa MetatorAI (`process.execPath`); spakowana binarka MetatorAI będzie potrzebować osobnej drogi.

## Zmienia
- Zmienia ADR-0102: sandbox nie jest już blokiem ustawień Claude Code, tylko środowiskiem, w którym MetatorAI uruchamia każdą sesję hosta; znika `sandbox.excludedCommands`; sekrety repozytorium są w `denyRead` jawnie.
- Realizuje wymóg ADR-0098 dla sandboxa.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Zostawić blok `sandbox` Claude Code i nic dla Copilota | funkcja jednego hosta (ADR-0098) |
| Oba: blok Claude Code i `srt` na zewnątrz | zagnieżdżony bubblewrap nie startuje |
| Sandbox tylko dla komend MetatorAI (`gate`, `test`) | nie obejmuje tego, co uruchamia agent |
| Kontener (docker) dla sesji | ciężki, wymaga demona dockera i obrazu; `srt` jest tym, czego używa sam Claude Code |

## Implikacje dla kodu
- Reguły kanonu, które to wiążą: polityka i ustawienia to czyste funkcje domeny (MT-ARCH-001), uruchamianie procesu tylko w adapterze portu (MT-ARCH-005, MT-ARCH-008), zależność wpisana do rejestru (MT-CODE-005); zachowanie ma testy na prawdziwym bubblewrap z zastępczymi hostami i e2e zestawu zgodności (MT-TEST-001), mutanty (MT-TEST-003).
- `packages/core/src/domain/sandbox.ts`, `packages/core/src/application/host-descriptors.ts` (`sandboxLaunch`), port `HostSandbox`.
- `packages/plugin-node/src/srt-sandbox.ts`, `packages/runtime/src/bootstrap.ts` (`sandboxLaunches`).
- `packages/plugin-host-claude/src/claude-host.ts`, `claude-agent-host.ts`, `packages/plugin-host-copilot/src/copilot-host.ts`, `copilot-agent-host.ts`.
- `packages/cli/src/daemon-client.ts`, `packages/core/src/domain/host-conformance.ts` (`sandbox-deny-read`).
