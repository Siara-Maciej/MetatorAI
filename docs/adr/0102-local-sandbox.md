# ADR-0102: Sandbox lokalny: środowisko ogranicza zasięg komend agenta

- Status: Accepted
- Data: 2026-11-15
- Numer: na gałęzi `claude/determined-galileo-4hfn27` ten ADR miał numer 0088, zajęty już w głównej linii; przenumerowany decyzją właściciela z 2026-11-22.

## Kontekst
Hook i reguła deny (ADR-0038, ADR-0100) decydują, **czy** wywołanie narzędzia ruszy. Nie ograniczają tego, do czego sięgnie proces, który już działa. `npm test` to zwykła komenda, ale uruchamia cudzy kod: zależności, skrypty napisane przed chwilą przez agenta. Taki proces potomny może otworzyć `.env` albo klucze SSH i wysłać je na dowolny host, a hook zobaczył tylko `npm test`. Człowiek zatwierdzający ręcznie też by to przepuścił. Zatrzymać to może tylko system operacyjny.

Decyzja właściciela (2026-11-15): pierwszym celem jest sandbox lokalny; profil sesji w chmurze później.

Claude Code ma sandbox komend powłoki (Seatbelt na macOS, bubblewrap na Linuksie i WSL2) konfigurowany w `settings.json#sandbox`. Jego konfiguracja łączy się z regułami uprawnień: reguły deny `Read`/`Edit` (ADR-0100) stają się zakazami dla procesów w sandboxie.

## Decyzja
- **Opcje repozytorium** (rejestr opcji, bez nowej wersji `MetatorConfig`): `sandbox.enabled` (domyślnie wyłączone), `sandbox.denyRead` (domyślnie `~/.ssh`, `~/.aws`, `~/.netrc`), `sandbox.allowWrite`, `sandbox.allowedDomains`, `sandbox.excludedCommands`.
- **Polityka w domenie:** `sandboxPolicy(config)` (`packages/core/src/domain/sandbox.ts`) składa opcje w jeden `SandboxPolicy`; `undefined`, gdy sandbox jest wyłączony.
- **Generator hosta:** `HostGenerator.hooks(…, sandbox?)`. Host Claude zapisuje blok `sandbox`: `enabled: true`, `allowUnsandboxedCommands: false` (komenda, która nie działa w sandboxie, nie jest ponawiana poza nim), listy polityki dopisane do list użytkownika; jego pozostałe klucze zostają. Bez polityki blok nie jest ruszany.
- **Sekrety repozytorium** nie są powtarzane w bloku `sandbox`: host sam przenosi do sandboxa reguły deny `Read` z ADR-0100.
- **`metator doctor`**: nowe sprawdzenie `isolation` mówi, czy sandbox jest włączony i czy ta maszyna go utrzyma (Linux: `bwrap` i `socat`; Windows natywnie: brak sandboxa), oraz czego sandbox nie obejmuje. Nie należy do ostrzeżeń pokazywanych przy każdym starcie runu.
- **Copilot** nie ma odpowiednika; tam obowiązują same hooki.

## Weryfikacja kryterium wyjścia
Kryterium etapu: zależność uruchomiona przez testy próbuje odczytać `.env` i dostaje odmowę od systemu. Sprawdzone ręcznie 2026-11-15 na Linuksie, tym samym runtime'em sandboxa, którego używa Claude Code (`@anthropic-ai/sandbox-runtime` z bubblewrap), z ustawieniami równoważnymi wygenerowanym:
- bez sandboxa pakiet z `node_modules` wczytany przez `bun test` odczytał `.env` i klucz z `~/.ssh`;
- w sandboxie ten sam test przeszedł, a pakiet dostał `EACCES` dla `.env` i `ENOENT` dla klucza.

To nie jest test automatyczny: CI nie ma bubblewrap, a GitHub-hosted runnery ograniczają przestrzenie nazw użytkownika. Automatycznie sprawdzane są: polityka z opcji, wygenerowane ustawienia (unit, e2e na prawdziwym procesie CLI) i sprawdzenie `isolation`. Przebieg przez prawdziwą sesję Claude Code z wygenerowanym plikiem pozostaje do sprawdzenia przez właściciela.

## Konsekwencje
### Pozytywne
- Trzecia warstwa obok hooka i reguł deny, jedyna, która obejmuje procesy potomne.
- Brak nowej wersji schematu konfiguracji; wyłączone domyślnie, więc istniejące repozytoria działają jak dotąd.

### Negatywne
- Obejmuje tylko komendy powłoki Claude Code. Hooki, serwery MCP, wbudowane narzędzia plikowe hosta i wszystko, co uruchamia Copilot, działają poza sandboxem.
- Z `~/.ssh` w `denyRead` push po SSH działa tylko przez agenta SSH.
- `allowUnsandboxedCommands: false` oznacza, że narzędzie niezgodne z sandboxem (np. docker) trzeba jawnie wpisać w `sandbox.excludedCommands`.
- Wyłączenie opcji nie usuwa bloku `sandbox` zapisanego wcześniej (generator nie odróżnia go od wpisu użytkownika); trzeba go usunąć ręcznie.

## Dalsze kroki (poza tym ADR)
- Komendy, które uruchamia sam MetatorAI (`metator gate`, `metator test`), w tym samym runtime'ie sandboxa: zadziała także pod Copilotem. Wymaga wpisu zależności i osobnego ADR.
- Profil sesji w chmurze (setup script, allowlista sieci, sekrety poza kontekstem modelu).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Tylko hook sprawdzający ścieżki w komendzie | nie widzi, co otwiera proces potomny |
| Sandbox włączony domyślnie | wymaga pakietów systemowych i może zatrzymać istniejące przepływy (docker, push po SSH) |
| Pola w `MetatorConfig` | nowa wersja schematu z migracją; rejestr opcji istnieje właśnie po to, by jej uniknąć |

## Implikacje dla kodu
- Reguły kanonu, które to wiążą: polityka sandboxa jest czystą funkcją domeny (MT-ARCH-001), port `HostGenerator` zostaje mały (MT-ARCH-008), generator w pluginie zna tylko `@metator/core` (MT-ARCH-005); `generate --hooks` i `doctor` mają e2e (MT-TEST-001), polityka i generator zabite mutanty (MT-TEST-003).
- `packages/core/src/domain/sandbox.ts`, `option-registry.ts`, port `HostGenerator`, `GenerateHostFiles`, `CheckReadiness` (`isolation`).
- `packages/plugin-host-claude/src/claude-generator.ts`: `sandboxSettings()`.
- Dokumentacja użytkownika: `site/repo/hooks.md` („Hold commands in a sandbox"), `site/reference/security.md`.
