# Roadmapa: fazy F0–F6

Zasada prowadzenia: **każda faza kończy się mierzalnym kryterium wyjścia** i zostawia repo w stanie używalnym. Zmiany w agentach od F3 przechodzą przez evale (W12).

```
F0 Audyt i spike ─► F1 Fundament (CLI, indeks, stan) ─► F2 Wiedza (reguły, wzorce, mapa pamięci)
      ─► F3 Review (Find/Verify/Judge + evale) ─► F4 Build (orchestrator, hooki, refactor)
      ─► F5 Automatyzacja (CI, nightly, coding agent) ─► F6 Uczenie się i skalowanie
```

Orientacyjnie: F0 1 tydz., F1 2 tyg., F2 2–3 tyg., F3 2–3 tyg., F4 3 tyg., F5 2 tyg., F6 ciągle. F2 i F3 mogą częściowo iść równolegle po F1.

---

## Audyt roadmapy (2026-10-26)

Porównanie roadmapy i katalogu komend ([04-commands §4](design/04-commands.md#4-katalog-skryptów)) z kodem. Kolejność realizacji: od góry.

**Do zrobienia w kodzie (P0 → P2):**
- [x] Run v2: `approvals` w `RunRecord` (migracja v1 → v2), `run approve <gate> --by --choice`.
- [x] Hooki `guard pre-tool|post-edit|stop|subagent-output|session-start|precompact`, `run checkpoint`, generowanie konfiguracji hooków dla Claude Code i Copilota (`generate --hooks`, ADR-0038).
- [x] `meta check-all`, `meta skills-lint`, kanoniczne skille i ich generowanie, `meta audit` (ADR-0039).
- [x] `symbols find`, `graph callers`, `api snapshot|diff` (ADR-0040).
- [x] `gate all`: kroki `test affected`, `graph diff`, `api diff`, `coverage diff`; `coverage diff` (ADR-0041).
- [x] `flaky check` (ADR-0041).
- [x] `workflow lint` (anatomia, 16 sekcji, ADR-0042).
- [x] Specyfikacje W1–W5 jako `Workflow` v2 w `.github/metator/workflows/`, `workflow lint` w `meta check-all` (ADR-0043).
- [x] `run handoff|close`, `lessons add`, `findings check-quote`, `debug-tags check` (ADR-0044).
- [x] `docs inventory|drift|links`, `owners` (ADR-0045).
- [x] Agenci: `mt-planner`, `mt-plan-critic`, `mt-test-author`, `mt-implementer`, `mt-refactorer`, `mt-pr-author`, `mt-review-equivalence`, `mt-diagnostician`, `mt-docs-curator`, `mt-retro`; skille `mt-characterization-tests`, `mt-create-*`, `mt-review-rubric`, `mt-grill`, `mt-diagnose`.
- [x] Karty: wzorce i właściciele z CODEOWNERS; API na poziomie symboli zostaje w `api snapshot` i `graph callers` (ADR-0045).
- [x] T0 ≤ 4000 znaków: `AGENTS.md` (Copilot i Claude Code czytają go jako T0; osobny `copilot-instructions.md` niepotrzebny), szczegóły w `packages/*/AGENTS.md`, budżet w mapie pamięci.
- [x] Autopilot (`--choice autopilot`, bramki `skipAt`), Author/Reviewer flow (`findings to-github --role`), schematy `Analysis` i `Research` (`run schema`, ADR-0046).

**Stan:** wszystko, co da się zrobić w kodzie tego repo, jest zrobione.

**Wymaga repo pilota lub ludzi (nie da się zamknąć w tym repo):** lub ludzi (nie da się zamknąć w tym repo):** F0 (inwentarz, spike platformy, baseline), złoty zbiór ≥ 50 PR-ów, 10–15 wzorców pilota, W7 na ADR pilota, rename agentów pilota, kryteria wyjścia faz mierzone na zadaniach pilota. W F6: procesy ciągłe (retro po runach, przegląd kwartalny, rozszerzanie na domeny), polityka Copilot Memory i opcjonalne integracje (MCP, StrykerJS, Semgrep).

**Odłożone decyzją:** F5.

---

## F0: Audyt istniejącego workflow i spike platformy (1 tydzień)

**Cel:** wiedzieć, co macie, co działa w Waszej wersji Copilota, i mieć baseline.

**Zadania**
- [ ] Inwentarz: agenci, prompty, skille, instrukcje, ADR (ręcznie albo pierwsza wersja `metator meta audit` + `metator memory inventory`). Narzędzia gotowe (`meta audit`, `memory inventory`, `docs inventory`); uruchomienie w repo pilota.
- [ ] Karta zgodności dla każdego orchestratora ([workflows §4](design/02-workflows.md#4-audyt-istniejących-orchestratorów)). Narzędzie gotowe (`workflow lint`, 16 sekcji); uruchomienie na orchestratorach pilota.
- [ ] Graf wywołań agent → agent/skill. Szukamy cykli, martwych elementów i zagnieżdżeń > 2. Narzędzie gotowe (`meta audit`); uruchomienie na agentach pilota.
- [ ] **Spike platformy** na wersji VS Code i CLI używanej w organizacji, z wynikami zapisanymi w ADR-0009:
  - [ ] frontmatter: `agents`, `user-invocable`, `disable-model-invocation`, `model` (lista), `handoffs`, nazwy tooli,
  - [ ] subagenci: czy idą równolegle, limit, czy dostają `AGENTS.md` i instrukcje `applyTo`,
  - [ ] hooki: nagranie realnych payloadów stdin dla `PreToolUse`, `PostToolUse`, `SubagentStop`, `Stop`, `PreCompact`. Który format decyzji działa (`hookSpecificOutput.permissionDecision` vs inne), zachowanie exit code,
  - [ ] skille ze skryptami: VS Code, Copilot CLI (`--agent`), coding agent,
  - [ ] polityki org: hooki (preview), MCP allowlist, dostępne modele (≥ 2 rodziny).
- [ ] Baseline: 3–5 realnych zadań i 10 PR-ów zrobionych obecnym workflow. Mierzymy czas, liczbę poprawek człowieka, błędy znalezione później i oceny trafności komentarzy review.

**Produkty:** `docs/metator/audit/AUDIT-<data>.md`, `docs/adr/0009-host-platform.md`, nagrane payloady hooków w `packages/testing/fixtures/hooks/`, baseline metryk.

**Kryterium wyjścia:** lista luk z priorytetami zaakceptowana. Wiadomo, które mechanizmy platformy są dostępne (jeśli hooki są niedostępne, fallback: bramki przez `mt-gatekeeper` + `metator run advance`).

**Ryzyka:** hooki wyłączone polityką → fallback opisany wyżej. Brak drugiej rodziny modeli → verifier na tym samym modelu, ale z innym promptem i *wyłącznie* dowodami wykonywalnymi dla blocking.

---

## F1: Fundament: CLI `metator`, indeks, stan runu (2 tygodnie)

**Cel:** warstwa faktów i maszyna stanów, na których stoją kolejne fazy.

**Postęp (2026-10-25)**
- [x] Monorepo Bun: `core` (domena, porty, use case `ComputeAffected`), `runtime` (kontener DI, koperta wyjścia, tokeny), `testing` (fakes, contract suite `FileSystem`), `plugin-bun` (`BunFileSystem`), `cli` (`version`, `help`).
- [x] Reguły architektury ast-grep z testami (`rules/architecture`), egzekwowane w CI.
- [x] CI (GitHub Actions): Biome, TypeScript 7, ast-grep, `bun test`.
- [x] ADR 0001–0008 (Proposed). Odkrycie: TS 7 bez klasycznego API kompilatora ([ADR-0008](adr/0008-typescript-7-graph.md)).
- [x] Gotowe biblioteki zamiast własnych ([ADR-0010](adr/0010-dependency-policy.md)): awilix (DI), @dagrejs/graphlib (graf: affected, cykle, ścieżki), XState v5 (maszyna stanów runu: etapy, pętle z limitami, bramki HITL, wznawianie z JSON), neverthrow, picomatch.
- [x] Testy: unit + e2e (proces CLI, grafiki README w Chromium, integralność dokumentacji) + mutacyjne.
- [x] Specyfikacje workflow w YAML walidowane schematem zod (typ, walidacja i JSON Schema z jednego źródła), katalog `.github/metator/workflows/`, przykład `examples/workflows/feature.yml`.
- [x] Runy: `metator run init|advance|status|list` na `RunStateMachine` (XState), stan w `.metator/runs/<id>/state.json` walidowany przy każdym odczycie, `log.md` jako ślad audytowy, wskaźnik `latest`.
- [x] Adaptery: `BunProcessRunner` (kontrakt `ProcessRunner`), `plugin-git` (`GitVcs`), komenda `metator changed`.
- [x] CLI na commanderze z wyjściem wyłącznie w JSON, composition root na awilix (`bootstrap`).
- [x] Wersjonowane dokumenty ([ADR-0016](adr/0016-versioned-documents.md)): `kind` + `schemaVersion` w każdym pliku (Workflow, RunRecord, RunLog, RunPointer), migracje i odrzucanie nowszych wersji, strażnik e2e.
- [x] Graf importów: `OxcImportAnalyzer` (oxc-parser + oxc-resolver, [ADR-0017](adr/0017-imports-oxc.md)), pakiety workspace przez manypkg ([ADR-0018](adr/0018-workspaces-manypkg.md)), przyrostowy indeks `.metator/index/imports.json` (wersjonowany `ImportIndex`). Komendy `metator index build`, `graph affected|deps|dependents|cycles|path|packages`, `workspace list`. E2e na monorepo z prawdziwym `bun install` i dogfood na repo MetatorAI (0 cykli).
- [x] `GitVcs` na simple-git zamiast ręcznych wywołań git ([ADR-0019](adr/0019-git-simple-git.md)); zmiana nazwy liczy się pod obiema ścieżkami.
- [x] `metator discover` ([ADR-0028](adr/0028-discovery.md)): package manager (package-manager-detector), workspace'y, klasyfikacja skryptów z `fileScopable` (shell-quote), narzędzia, CI, code host, pliki AI → `.metator/discovery.json`.
- [x] `metator.config` (wersjonowany `MetatorConfig`), `metator init [--dry-run]` z decyzjami i dowodami, `gate quick|full [--files|--base]` z raportem `.metator/gates/<gate>.json` ([ADR-0029](adr/0029-config-gates.md)). Dogfood: `metator.config.yml` MetatorAI.

**Zadania**
- [x] Szkielet `metator` (envelope, workspace, git, cache, budget) + `bun test` na fixture'ze mini-monorepo.
- [x] P0 z indeksu: `index build`, `graph deps|affected|callers|diff`, `symbols find`, `api snapshot|diff`.
- [x] `sgconfig.yml` (jeśli go nie ma) z `ruleDirs` i `testConfigs`. Przeniesienie istniejących skryptów ast-grep do reguł z testami (w repo pilota: przy wdrożeniu).
- [x] `run init|advance|status|approve`, schematy `state` (`RunRecord`), `analysis`, `research` (`run schema`, ADR-0046), `plan`, `finding`, `verdict`, `gates`.
- [x] Agenci kanoniczni, `meta agents-lint`, `generate [--check]` dla Copilota i Claude Code ([ADR-0030](adr/0030-canonical-agents.md)); 5 agentów MetatorAI.
- [ ] `meta skills-lint|check-all`, generowanie skilli, promptów i hooków. **Rename istniejących agentów i skilli na `mt-*`** w repo pilota.
- [ ] Spec YAML dla istniejących orchestratorów (wydzielenie z promptów). `workflow lint` w wersji podstawowej.
- [x] CI: job `mt-check` (`meta check-all`, `ast-grep test`, `bun test metator`): `.github/workflows/ci.yml` w MetatorAI (`bun run canon`, `bun run arch`, testy, mutanty); w repo pilota ten sam zestaw.

**Produkty:** działające `metator …`, `.github/metator/workflows/*.yml`, zielony job CI.

**Kryterium wyjścia:** `graph affected` zgodny z ręczną weryfikacją na 10 PR-ach (≥ 95% plików). `run advance` blokuje przeskok etapu w teście. Wszyscy agenci przechodzą `agents-lint`.

---

## F2: Wiedza: reguły z ADR, wzorce, karty, mapa pamięci (2–3 tygodnie)

**Cel:** canon w jednym miejscu, reguły z ID, wzorce z exemplarami, pamięć pod kontrolą.

**Zadania**
- [x] Mapa pamięci ([ADR-0021](adr/0021-memory-map.md)): `MemoryMap` w `docs/metator/memory-map.yml`, `memory inventory|budget|validate [--fix]|check|schema`, cytaty `[[cite: …]]` z naprawą przesunięć, strażnik w `bun run canon`. Dogfood: mapa MetatorAI (8 pozycji, 40 plików wiedzy).
- [x] `memory dupes [--check]` i `memory matrix` ([ADR-0026](adr/0026-memory-dupes.md)); dogfood: usunięty duplikat ADR-0004 ↔ ARCHITECTURE.md, `memory dupes --check` w `bun run canon`.
- [x] Odchudzenie T0: `AGENTS.md` 3,9 tys. znaków (budżet T0 4000), `AGENTS.md` per pakiet (`t1.package-agents`).
- [ ] **W7 na istniejących ADR i docs** (`mt-docs-curator`): twierdzenia → weryfikacja w kodzie → reguły `MT-*` → HITL → canon. Narzędzia gotowe (`docs inventory|links|drift`, `ClaimSet`, dogfood: 3 twierdzenia MetatorAI w `docs/metator/claims.json`); przebieg na ADR pilota.
- [x] `adr lint` ([ADR-0024](adr/0024-adr-lint.md)): numeracja, status i `Superseded by`, sekcje (PL/EN), ADR `Accepted` z „Implikacjami dla kodu” wskazującymi reguły kanonu, spójny indeks; w `bun run canon`.
- [x] Kanon reguł ([ADR-0020](adr/0020-rule-canon.md)): `RuleSet` YAML w `docs/metator/rules`, `rules lint|pack|show|adapters|check|schema`, silnik E1 ast-grep, wygenerowane `.github/instructions/mt-*.instructions.md`, `bun run canon` w CI. Dogfood: 16 reguł MetatorAI (5 × E1).
- [x] Reguły E1: ≥ 40% reguł jako E1 (MetatorAI: 50%, ast-grep z testami).
- [x] `rules coverage [--min-e1]` i `rules scaffold <id>` (port `RuleScaffolder`, adapter ast-grep: reguła + test, który nie przechodzi, dopóki nie wpiszesz prawdziwych przypadków). Dogfood: 3 reguły MetatorAI awansowane z E2 do E1 (MT-CODE-001, MT-CODE-004, MT-ARCH-007), E1 = 50%, bramka `--min-e1 40` w `bun run canon`.
- [x] Silnik E1 Biome przez SARIF ([ADR-0025](adr/0025-biome-engine-sarif.md)); dogfood: MT-CODE-006/007, E1 = 56%.
- [x] Silnik E1 tsc i sprawdzanie, że reguła narzędzia jest włączona ([ADR-0027](adr/0027-tsc-engine.md)); `rules check` uruchamia tylko silniki używane przez kanon. Dogfood: MT-CODE-008/009, E1 = 60%.
- [x] Katalog wzorców ([ADR-0023](adr/0023-pattern-catalog.md)): `Pattern` YAML, wykrywanie regułami ast-grep (`severity: hint`, z testami), `patterns scan [--check]`, `similar`, indeks `.metator/index/patterns.json`. Dogfood: 4 wzorce MetatorAI (use-case, versioned-document, cli-command-group, port-adapter).
- [ ] Kolejne wzorce do 10–15 w repo pilota.
- [x] Karty modułów ([ADR-0022](adr/0022-module-cards.md)): `cards build [--check]`, blok generowany z grafu (zależności, testowe osobno, użytkownicy, powierzchnia publiczna, biblioteki), sekcje kuratorowane z cytatami. Dogfood: 9 kart MetatorAI z 11 prawdziwymi cytatami.
- [x] Karty: publiczne API na poziomie symboli (`api snapshot`), wzorce, właściciele z CODEOWNERS (ADR-0045).

**Kryterium wyjścia:** `memory check` zielony, 0 duplikatów reguł poza canon, 100% reguł z ID i źródłem, ≥ 40% E1, każdy wzorzec ma exemplar i ≥ 2 wystąpienia, karty dla 100% pakietów pilota.

---

## F3: Review: Find, Verify, Judge + evale (2–3 tygodnie)

**Cel:** review, któremu można ufać, z mierzoną trafnością.

**Zadania**
- [x] Skill `mt-review-rubric` (przeniesienie checklist z eq-logic-reviewer w repo pilota).
- [x] `findings validate [--fix]|merge|schema` ([ADR-0031](adr/0031-findings.md)): `FindingSet`, polityka blocking, cytaty sprawdzane w kodzie, scalanie przyczyn między soczewkami.
- [x] Subflow review ([ADR-0032](adr/0032-review-core.md)): `review plan`, `findings verdict`, `findings to-github --format natural|labeled`, agenci `mt-pr-review`, `mt-review-{logic,contracts,conventions,tests,security}`, `mt-verifier`, `mt-judge`.
- [x] Hook `SubagentStop` → `guard subagent-output` (ADR-0038).
- [ ] **Złoty zbiór v1:** ≥ 50 PR-ów: z prawdziwymi bugami (z hotfixów i revertów), z zasianymi bugami (mutacje w kopii PR-a) i czyste (kontrola FP). Format w `docs/metator/evals/golden/`.
- [x] `eval run|score|compare|schema` ([ADR-0033](adr/0033-review-evals.md)): `EvalCase`, precision/recall, blocking precision, fałszywe blokady, wariancja decyzji, bramka regresji; host jako szablon komendy (np. `copilot -p … --agent mt-pr-review --no-ask-user -s`).
- [x] Zachowanie trybów eq: Author/Reviewer flow (`findings to-github --role author|reviewer`), format naturalny/etykietowany, autopilot (`--choice autopilot` → L1, bramki `skipAt` zatwierdzane przez poziom autonomii, `neverSkip` i push zawsze przez człowieka; ADR-0046).

**Kryterium wyjścia (na złotym zbiorze, 3 powtórzenia):** precision confirmed-blocking ≥ 85%, recall zasianych bugów ≥ 60%, wariancja decyzji ≤ 10%, koszt/PR w uzgodnionym budżecie. Wynik lepszy niż baseline z F0.

---

## F4: Build: orchestrator, hooki, TDD, refactor (3 tygodnie)

**Cel:** doszlifowany orchestrator jako maszyna stanów z twardymi bramkami.

**Zadania**
- [x] `mt-orchestrator` wg spec W1/W2/W3. Prompt skrócony do zasad delegacji (≤ 200 linii).
- [x] Workerzy: `mt-scout`, `mt-pattern-miner`, `mt-rule-curator`, `mt-planner`, `mt-plan-critic`, `mt-test-author`, `mt-implementer`, `mt-refactorer`, `mt-gatekeeper`, `mt-pr-author`.
- [x] `plan lint|scope` (pattern_source, TDD order, kolejność wg grafu, shardy).
- [x] Hooki: `pre-tool` (scope, approvals, sekrety, rola), `post-edit` (biome + ast-grep), `stop`, `precompact`, `session-start` (ADR-0038).
- [x] Gate: `gate quick|all`, `test affected`, `coverage diff`, `graph diff`, `api diff`.
  - [x] `gate quick|full` (ADR-0029), `test affected`, `graph diff` (ADR-0036).
  - [x] `coverage diff`, `api diff`, kroki `test affected` i `graph diff` w bramce (ADR-0040, ADR-0041).
- [x] Refactor: skill `mt-characterization-tests`, `equivalence.md`, soczewka `mt-review-equivalence`.
- [x] Skille `mt-create-*` (z eq-create-*) z exemplarami z indeksu zamiast szablonów na sztywno.

**Kryterium wyjścia (10 realnych zadań pilota):** ≥ 90% kroków `create` z `pattern_source`, 0 naruszeń granic po G6, 0 edycji poza scope (log hooka), ≥ 1 refactor z zerowym api diff i coverage ≥ baseline, czas zadania ≤ baseline albo mniej poprawek człowieka.

---

## F5: Automatyzacja: CI, nightly, coding agent (2 tygodnie)

> **Decyzja 2026-10-25:** na teraz tylko tryb interaktywny w VS Code. F5 jest odłożone. Do tego czasu tryb auto istnieje jako demo lokalne ([running, część B](design/06-running.md#część-b-tryb-auto-copilot-cli--skrypty-demonstracja)).

**Zadania**
- [ ] `.github/workflows/mt-pr-review.yml`: review headless L2 na PR-ach pilota (tylko komentarze `confirmed blocking`, reszta w podsumowaniu).
- [ ] `.github/workflows/mt-nightly.yml`: W10 knowledge refresh (PR z częścią generowaną + issue z driftem).
- [ ] `.github/workflows/mt-eval.yml`: W12 dla zmian w agentach.
- [ ] `copilot-setup-steps.yml` dla coding agenta (`bun install`, `metator index build`).
- [ ] Natywny Copilot code review: lekkie instrukcje. Ciężkie mają `excludeAgent: code-review`, żeby nie dublować mt-pr-review.
- [ ] Telemetria: agregacja `telemetry.jsonl` i reakcji na komentarze (resolved/dismissed) → dashboard.

**Kryterium wyjścia:** review w CI na 100% PR-ów pilota przez 2 tygodnie, odsetek dismissed ≤ 15%, nightly zielony.

---

## F6: Uczenie się i skalowanie (ciągle)

**Zadania**
- [ ] W11 `mt-retro` po każdym większym runie. Lessons z cytatami, awans lekcji do reguł (i do E1). Narzędzia gotowe (`mt-retro`, `lessons add`, `rules scaffold`, `run close`); proces ciągły.
- [ ] Polityka Copilot Memory (co wolno, przegląd konfliktów z canon).
- [ ] Rozszerzenie na kolejne domeny monorepo: karty, wzorce, reguły per domena, złoty zbiór per domena.
- [ ] Opcjonalnie: MCP `metator-knowledge` (indeks dostępny dla wielu repo i powierzchni), StrykerJS (mutation score jako bramka), Semgrep (soczewka security).
- [ ] Kwartalny przegląd: evale, progi, budżety, martwe reguły (`rules coverage`), nieużywane lessons. Narzędzia gotowe (`eval compare`, `memory budget`, `rules coverage`, `docs inventory` z wiekiem plików); proces ciągły.

**KPI programu:** precision i recall review (eval + produkcja), dismissed rate, % reguł E1, naruszenia architektury wykryte po merge (→ 0), lead time zadania, poprawki człowieka na zadanie, koszt tokenów na zadanie/PR, liczba eskalacji na run.


---

## F7: System wielu aplikacji (MVP: OpenAPI)

**Cel:** agent analizuje zadanie w kontekście całego systemu: które aplikacje i kontrakty dotyka zmiana, czy jest łamiąca, w jakiej kolejności ją wdrożyć i kto jest właścicielem. Analiza, decyzje i plan: [design/08-system-landscape.md](design/08-system-landscape.md).

**Zadania (MVP)**
- [x] F7.1 `SystemMap` v1 (aplikacje, kontrakty, polityki), rejestr rodzajów kontraktów (MVP: `openapi`), `system schema|show|lint`, `system lint` w `meta check-all` (ADR-0047). Karty aplikacji w F7.5.
- [ ] F7.2 Automatyczna topologia (monorepo albo osobne repo) i `system discover` (aplikacje, specyfikacje OpenAPI, konsumenci z dowodami).
- [ ] F7.3 Port `SystemSourceReader` (lokalny checkout, klon do cache zależnie od użycia), mapa w repo platformy przypięta w aplikacjach, `system impact`.
- [ ] F7.4 Port `ContractDiffer`, provider OpenAPI (`openapi-diff`), `contract diff`, krok bramki w `gate full`.
- [ ] F7.5 `SystemAnalysis`, `SystemPlan`, `system plan lint`, agenci `mt-system-scout`, `mt-system-planner`, karty aplikacji.
- [ ] F7.6 Runy powiązane (`RunRecord` v3: rodzic i dzieci), `system status`, workflow W13 `mt-system-change`.
- [ ] F7.7 Przypadki wieloaplikacyjne w złotym zbiorze, score impact i planu.

**Post-MVP:** AsyncAPI, GraphQL, gRPC, pakiety npm, schemat bazy i konfiguracja jako kontrakty; `oasdiff`; katalog Backstage; kolejność wdrożeń z pipeline'ów; źródło przez API hosta; Pact (lista w [design §9](design/08-system-landscape.md#9-post-mvp-do-zrobienia-później)).

**Kryterium wyjścia (pilot):** `system impact` wskazuje ≥ 95% dotkniętych aplikacji na 10 historycznych zmianach; każda zmiana łamiąca kontraktu wykryta; plan systemowy dla 5 zadań zatwierdzony bez zmian kolejności.
## F8: Sesje, worktree i środowiska aplikacji

**Cel:** jedna komenda instaluje MetatorAI z wybranym hostem agentów; run działa w swoim worktree, prowadzony na żywo w CLI, z pytaniami w miejscu i `run continue`; `metator ui` przełącza sesje i uruchamia ich aplikacje; MetatorAI sam wie, jak wystartować aplikację, i skraca zimny start przez współdzielenie i częściowy start. Analiza, plan i decyzje: [design/09-workspaces-sessions.md](design/09-workspaces-sessions.md).

**Zadania**
- [x] F8.1 `setup`, `agents install|update` (kanon z pakietu, wybór hostów, `InstallLock` v1, kreator w terminalu; ADR-0049).
- [x] F8.2 `worktree new|list|rm|prune`, dzierżawy portów, `run init --worktree`, `RunRecord` v3 (ADR-0050).
- [ ] F8.3 Port `AgentHost` (Claude Agent SDK, Copilot CLI, adapter testowy), `run drive|stop`, `RunEvent` v1, `Question` v1 (sedno odłożonego F5).
- [ ] F8.4 Interaktywny `metator run` i `run continue` (widok na żywo, pytania i bramki w miejscu).
- [ ] F8.5 `Environment` v1, `env discover|init|up|down|status|logs` (Docker Compose, skrypty, Procfile, Makefile; devcontainer post-MVP).
- [ ] F8.6 `metator ui`: sesje, skrzynka pytań, aplikacje sesji, edytor, powłoka, diff.
- [ ] F8.7 `env analyze`, izolacja danych (Postgres template, prefiksy), częściowy start z `affected`/`impact`, reuse buildu, pula ciepłych worktree.
- [ ] F8.8 Dystrybucja: pakiet npm `metator-ai` (CLI zbudowane `bun build`, kanon w paczce), żeby działały `npx|pnpm dlx|yarn dlx|bunx metator` i instalacja jako dev dependency; wymaga konta npm właściciela.

**Kryterium wyjścia:** puste repo do zielonych sprawdzeń kanonu i plików hosta jedną komendą; dwie równoległe sesje w osobnych worktree z rozłącznymi portami; drugi worktree aplikacji z wolnym seedem startuje ≥ 10× szybciej niż zimny start (zmierzone).

---

## Role i odpowiedzialności

| Rola | Odpowiada za |
|------|--------------|
| **AI Platform owner** (CODEOWNERS na `.github/agents|skills|hooks`, `metator`) | agenci, skille, CLI, evale, progi |
| **Architekci domen** | ADR, akceptacja reguł i wzorców, karty modułów (część kuratorowana) |
| **Tech leadzi zespołów** | pilotaż, złoty zbiór z ich domeny, feedback z retro |
| **Security** | soczewka security, polityka MCP i sekretów, przegląd hooków |
| **Deweloperzy** | używanie workflow, reakcje na komentarze (dane do evali), propozycje lessons |

## Mapowanie na Twój obecny stan

| Masz | Co z tym robimy | Faza |
|------|-----------------|------|
| Wstępne ADR | W7: weryfikacja w kodzie, sekcja „Implikacje”, wyciągnięcie reguł `MT-*` | F2 |
| Minimalistyczne orchestratory | audyt → spec YAML → `metator run` → hooki → podział review | F0 → F1 → F4 |
| Skrypty ast-grep | przeniesienie do `sgconfig.yml` jako reguły z testami + wykrywanie wzorców | F1–F2 |
| Biome | bramki (`gate`), `post-edit`, `noRestrictedImports` + GritQL dla reguł E1 | F2–F4 |
| tsc | graf (TS API), API snapshot/diff, bramka typów | F1 |
| Bun | runtime CLI, `bun test` (projekt i `metator`), coverage lcov, `--rerun-each` | F1+ |
