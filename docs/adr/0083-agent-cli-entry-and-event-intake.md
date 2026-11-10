# ADR-0083: CLI agenta jako punkt wejścia; zdarzenia z zewnątrz (issue, review) jako drugie wejście do tej samej ścieżki

- Status: Accepted
- Data: 2026-11-10

## Kontekst
Zaakceptowany przez właściciela 2026-11-10 (odpowiedzi na pytania projektu w design/14 §0).

Od fazy R dyrygent (`mt-orchestrator`) biegnie w PTY Copilot CLI i sam woła `metator run init|advance|delegate`; aplikacja pokazuje ten terminal 1:1 (ADR-0080, design/13). Mimo to człowiek zaczyna zadanie z formularza „New session” (workflow, autonomia, host, worktree), a potem patrzy na agenta. Właściciel (2026-11-10) rozstrzygnął, że to odwrócony porządek: każde zadanie ma zaczynać się od rozmowy w CLI agenta, a formularz jest potrzebny tylko automatowi. Drugi brak: MetatorAI recenzuje cudze zmiany (`mt-pr-review`, `findings to-github`), ale nie reaguje na recenzje własnych MR-ów, choć analiza review i plan poprawek to najczęstsza powtarzalna czynność autora.

## Decyzja
- **Jedna ścieżka startu, dwa wejścia.** Każda sesja powstaje przez `POST /runs` demona (dziś woła to formularz i `issue start`). Wejście A: rozmowa w pane Copilot CLI z `mt-orchestrator` w trybie *intake*: osoba pyta o repozytorium albo opisuje zadanie; agent odpowiada z cytatami (jak `metator ask`), a sesję zakłada dopiero wtedy, gdy z rozmowy wynika zadanie, dopytując (`mt-grill`) tylko o to, czego nie wyczyta z repozytorium. Wejście B: `metator intake`, cykliczny proces demona (domyślnie co 120 s), który z reguł per źródło (GitHub, GitLab, Jira przez MCP) tworzy issue i sesje. Formularz zostaje pod „zaawansowane” i jako edytor reguł automatu.
- **Zgoda per źródło, nie globalnie.** Reguła wejścia mówi: źródło, filtr (etykieta, typ, projekt), repozytorium z `metator.repos.yml`, workflow, autonomia. Domyślnie automat tworzy issue i sesję, a pierwsza bramka workflow pyta osobę; pełna autonomia do PR jest opcją reguły (np. `bug` + `auto`), nigdy domyślną.
- **Review jest zdarzeniem jak issue.** Port `CodeHost` (odczyt: moje otwarte PR/MR, wątki review, CI; zapis: odpowiedź w wątku, resolve) z adapterami przez MCP hosta kodu. Nowa recenzja na moim MR tworzy dokument `ReviewThread` i sesję workflow `mt-review-response`: zebranie wątków, odpowiedzi na pytania z diffu, plan poprawek, **bramka HITL**, poprawka na gałęzi MR w worktree, odpowiedzi i resolve. Analiza i plan są automatyczne; zmiana kodu po decyzji osoby. Treść wątków to dane zadania, nie instrukcje dla agenta.
- **MCP konfiguruje się w MetatorAI.** Sekcja `mcp:` w `metator.config.yml` (repo) i w `UserOptions` (osoba); `metator generate` wpisuje ją do konfiguracji hosta (Copilot CLI, Claude Code), tak jak dziś wpisuje agentów i skille. Agent w intake ma więc te same serwery MCP, co automat.
- **Konfiguracja reguł** żyje w `metator.config.yml` per repozytorium i w `metator.repos.yml` dla listy repozytoriów; nie powstaje nowy format.
- **Idempotencja i ślad.** Klucz źródła (`github:owner/repo#12`, `jira:ABC-123`, `review:owner/repo#45@<thread>`) w Issue i w aktywności runu; ponowny skan nic nie dubluje. Automat działa z własną tożsamością (`by: intake`), tokeny poza repozytorium.

## Konsekwencje
- Pozytywne: człowiek nie wyklikuje sesji; to samo wejście obsługuje człowieka, issue z Jiry i review z GitHuba; bramki i polityki odpowiedzi (P5) sterują autonomią bez nowego mechanizmu; apka zostaje tym, czym jest: kafelki domyślnie, terminal na żądanie.
- Negatywne: demon dostaje proces cykliczny i tokeny do hostów kodu; każde nowe źródło to adapter i reguły; recenzja obcej osoby staje się wejściem do agenta, stąd bramka przed zmianą kodu i traktowanie treści jako danych.

## Implikacje dla kodu
- Reguły kanonu, które to wiążą: `CodeHost` jest portem z adapterem w pluginie, wstrzykiwanym przez konstruktor (MT-ARCH-005, MT-ARCH-006, MT-ARCH-007, MT-ARCH-008); `IntakeRule`, `ReviewThread` i `Issue` v2 to wersjonowane dokumenty z migracją i zamrożonym schematem (MT-CODE-002, MT-CODE-003); błędy hosta kodu wracają jako wartości (MT-CODE-001); `metator intake`, `metator mrs` i tryb intake mają e2e na prawdziwym procesie (MT-TEST-001), adapter MCP przechodzi kontrakt portu (MT-TEST-002), nowe moduły mają zabite mutanty (MT-TEST-003); klient MCP jako zależność wymaga wpisu w rejestrze (MT-CODE-005).
- `core`: port `CodeHost`, dokumenty `IntakeRule` (w `MetatorConfig`), `ReviewThread` v1, use case'y `ScanIntake`, `RespondToReview`; `Issue` dostaje `source`.
- `plugin-codehost-mcp` (GitHub, GitLab, Jira przez MCP hosta); `runtime`: rejestracja, pętla `intake` w demonie; `cli`: `metator intake scan|rules|run`, `metator mrs`; workflow `mt-review-response`; `mt-orchestrator`: sekcja *intake*; `metator generate`: konfiguracja MCP hosta.
- `desktop`: „+ New session” otwiera pane z orkiestratorem; zakładka **Open MRs**; formularz pod „zaawansowane”.
- Projekt szczegółowy: [design/14](../design/14-intake-and-review.md); plan: ROADMAP, faza T.
