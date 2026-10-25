# Workflowy: anatomia, specyfikacja, katalog, audyt

## 1. Anatomia: co **musi** zawierać każdy workflow

Workflow bez któregokolwiek z poniższych punktów nie przechodzi `metator workflow lint`.

| # | Sekcja | Pytanie, na które odpowiada | Przykład |
|---|--------|-----------------------------|----------|
| 1 | **Trigger / entry** | Kto i jak go uruchamia? | `/mt-feature AB#123`, PR opened (CI), nightly cron |
| 2 | **Kontrakt wejścia** | Jakie dane są wymagane, jak je walidujemy? | `task_ref` lub `task_text`; `autonomy` ∈ L0/L1/L2 |
| 3 | **Warunki wstępne** | Co musi być prawdą przed startem? | czysty working tree, aktualny index, branch zgodny z konwencją |
| 4 | **Etapy** | Jakie kroki, w jakiej kolejności, kto jest właścicielem? | G0…G9, każdy z `owner` (agent/skill/skrypt) |
| 5 | **Artefakty etapów** | Co powstaje, w jakim schemacie? | `analysis.json` (schema `analysis@1`) |
| 6 | **Bramki** | Kiedy etap jest zakończony i poprawny? | skrypt → LLM → człowiek |
| 7 | **Plan równoległości** | Co może iść równolegle, z jakim limitem? | G2: 3 workerów; G7 Find: lens × shard, max 6 |
| 8 | **Pętle i limity** | Ile razy wolno wrócić? | plan 2, build 2, review 3 |
| 9 | **Eskalacja** | Co się dzieje po przekroczeniu limitu albo przy niejasności? | raport + opcje dla człowieka |
| 10 | **Poziomy autonomii** | Które bramki HITL można pominąć i na jakim poziomie? | L1 pomija G4b, nigdy G8 |
| 11 | **Uprawnienia** | Kto może edytować co, jakie akcje zewnętrzne? | edycja tylko `plan-scope`, push po approval |
| 12 | **Definition of Done** | Kiedy workflow jest skończony? | gates PASS + verdict APPROVED + PR utworzony |
| 13 | **Tryby awarii i recovery** | Co, gdy testy, hook albo narzędzie padną? | `mt-diagnose`, retry 1×, eskalacja |
| 14 | **Wznowienie** | Jak kontynuować po przerwie lub kompakcji? | `metator run status` → ostatni zatwierdzony etap |
| 15 | **Telemetria** | Co mierzymy? | czas etapów, tokeny, liczba pętli, eskalacje, wynik |
| 16 | **Wyjście / raport** | Co dostaje użytkownik na końcu? | raport w stałym formacie + linki do artefaktów |

---

## 2. Workflow jako maszyna stanów (`.github/metator/workflows/*.yml`)

Ten element zamienia zestaw skilli w enterprise workflow. Specyfikacja jest **czytana przez skrypt** (`metator run`), nie tylko przez model.

```yaml
# .github/metator/workflows/mt-feature.yml
id: mt-feature
version: 3
owner: mt-orchestrator
entry: { prompt: mt-feature, ci: false }
input:
  oneOf: [task_ref, task_text]
  optional: { autonomy: { enum: [L0, L1], default: L0 } }
preconditions: [clean-tree, index-fresh, branch-ok]
limits: { parallel: 6, loops: { plan: 2, build: 2, review: 3 } }
stages:
  - id: G0-setup
    owner: skill:mt-branch-setup
    produces: []
    gate: { script: "metator run check preconditions" }
  - id: G1-intake
    owner: mt-orchestrator
    produces: [task.md]
    hitl: { when: "task.ambiguity == true", skill: mt-grill }
  - id: G2-context
    parallel: [mt-scout, mt-pattern-miner, mt-rule-curator]
    produces: [analysis.json, research.json, rulepack.md]
    gate: { schema: [analysis@1, research@1] }
  - id: G3-plan
    owner: mt-planner
    produces: [plan.json, plan-scope.json]
  - id: G4-plan-gate
    gate:
      script: "metator plan lint"
      llm: mt-plan-critic
      on_fail: { goto: G3-plan, loop: plan }
  - id: G4b-approval
    hitl: { required: true, skip_if_autonomy: [L1] }
  - id: G5-build
    owner: [mt-test-author, mt-implementer]
    parallel_by: plan.shards          # niezależne shardy planu (brak krawędzi w grafie)
    produces: [build-log.md]
    guards: [plan-scope, post-edit-lint]
  - id: G6-gates
    owner: mt-gatekeeper
    produces: [gates.json]
    gate: { script: "metator gate all --affected", on_fail: { goto: G5-build, loop: build, then: skill:mt-diagnose } }
  - id: G7-review
    subflow: mt-review-core          # Find → Verify → Judge (współdzielone z mt-pr-review)
    produces: [verdict.json]
    gate: { verdict: APPROVED, on_fail: { goto: G3-plan, scope: blocking-only, loop: review } }
  - id: G8-delivery
    owner: mt-pr-author
    hitl: { required: true, never_skip: true }
  - id: G9-learn
    optional: true
    subflow: mt-retro
escalation:
  on_loop_exhausted: { report: open-issues, options: [continue, manual, abort] }
  on_ambiguity: stop-and-ask
done: [gates.json.pass, verdict.json.decision == APPROVED, approvals.push]
telemetry: [stage_duration, tokens, loops, escalations, outcome]
```

**Jak to jest egzekwowane:**
- `metator run init` tworzy `state.json` ze spec i wejścia.
- `metator run advance <stage>` sprawdza, czy etap jest następny w kolejności, czy artefakty istnieją i są zgodne ze schematem, czy bramka ma wynik PASS i czy nie przekroczono limitu pętli. Jeśli któryś warunek nie jest spełniony, zwraca `ok:false` + powód.
- Hook `Stop`: jeśli `state.json.stage` nie jest terminalny i nie ma eskalacji, blokuje zakończenie z komunikatem, czego brakuje.
- Hook `pre-tool`: czyta `state.json.permissions` (np. `edit_scope`, `approvals`).

---

## 3. Katalog workflowów `mt-*`

### W1 `mt-feature`: nowa funkcjonalność
- **Entry:** `/mt-feature <ADO|issue|tekst>` · **Owner:** `mt-orchestrator`
- **Etapy:** G0–G9 jak w spec wyżej.
- **Kluczowe bramki:** `plan lint` (każdy krok `create` ma `pattern_source`), `gate all`, review core.
- **DoD:** testy RED→GREEN udokumentowane, gates PASS, verdict APPROVED, PR po approval.

### W2 `mt-bugfix`: naprawa błędu
- Różnice względem W1: G2 zawiera `mt-diagnostician` (pętla feedbacku z eq-diagnose). G3 wymaga **testu regresyjnego, który odtwarza błąd** (artefakt `repro.json` z komendą i wynikiem FAIL przed fixem).
- **DoD:** repro FAIL → PASS, brak nowych krawędzi w grafie, review core bez blocking.

### W3 `mt-refactor`: refactor z zachowaniem logiki
- **Etapy dodatkowe:** R1 `metator api snapshot` (przed), R2 testy charakteryzacyjne (`mt-characterization-tests`, muszą przejść na starym kodzie), R3 `equivalence.md` (inwentarz zachowań per funkcja), plan w małych krokach, po każdym kroku `metator gate quick` + `metator api diff` + `metator graph diff`.
- **Bramka końcowa:** api diff = brak zmian (lub tylko zaplanowane), coverage ≥ baseline, soczewka `mt-review-equivalence` bez potwierdzonych blocking.
- **DoD:** każda zmiana cytuje regułę `MT-*` albo wzorzec. Brak zmian zachowania.

### W4 `mt-pr-review`: review PR (cudzy / interaktywny / CI)
- **Entry:** `/mt-review <PR>` lub CI (L2) · **Owner:** `mt-pr-review`
- **Etapy:** P0 metadata + autorstwo (zachowane z eq: Author/Reviewer flow), P1 `metator graph affected --diff` + sharding, P2 rule pack per shard, P3 **review core** (sekcja 3.1), P4 raport, P5 HITL: format komentarzy (naturalny/etykietowany), zakres (blocking/all), P6 publikacja.
- **DoD:** verdict + opublikowane komentarze (po approval lub w L2 automatycznie, tylko `confirmed blocking`).

### W5 `mt-self-review`: własny PR, pętla naprawcza (dawny Mode D)
- review core → planner (tylko blocking) → implementer → review core, max 3–5 rund. Bez push i bez komentarzy na GitHubie.
- **DoD:** 0 confirmed blocking albo eskalacja z listą.

#### 3.1 Subflow `mt-review-core` (współdzielony przez W1, W3, W4, W5)
```
FIND   (parallel: lens × shard, max 6)
       lens ∈ {logic, contracts, conventions, tests, security, equivalence*}
       → findings/<lens>-<shard>.json  (schema finding@1)
VALID  metator findings validate        # cytaty istnieją, wymagane pola, blocking ma trigger+reachability
DEDUP  metator findings merge           # klucz: file+symbol+root-cause hash
VERIFY (parallel per finding ≥ major, max 6) mt-verifier → confirmed | refuted | unproven
JUDGE  mt-judge → verdict.json (decision, severity calibrated, verified-correct list)
```

### W6 `mt-test-hardening`: wzmocnienie testów modułu
- **Wejście:** pakiet/ścieżka. **Etapy:** `metator coverage report` + lista niepokrytych gałęzi → plan testów (wg wzorców testowych z katalogu) → `mt-test-author` → bramka: coverage ↑, testy deterministyczne (3 przebiegi `bun test --rerun-each=3` albo pętla w skrypcie), brak asercji na szczegółach implementacji (soczewka tests).
- **DoD:** coverage na pakiecie ≥ cel, 0 flaky w 3 przebiegach.

### W7 `mt-docs-analysis`: dokumentacja → reguły, wzorce, ADR
- **Entry:** `/mt-docs [zakres]` · **Owner:** `mt-docs-curator`
- **Etapy:** D1 `metator docs inventory` → D2 ekstrakcja twierdzeń (parallel per dokument) → D3 weryfikacja twierdzeń w kodzie (parallel per twierdzenie, dowód `file:line`) → D4 klasyfikacja (reguła/wzorzec/ADR/glossary/fakt modułu) → D5 poziom egzekucji + szkic reguły ast-grep/Biome dla E1 (z testem) → D6 HITL tabela zmian → D7 publikacja + `metator rules adapters`.
- **DoD:** każde twierdzenie ma status `verified | drift | no-evidence`. Zatwierdzone reguły w canon, adaptery wygenerowane, reguły E1 z testami.

### W8 `mt-investigate`: diagnoza (bug, flaky, regresja wydajności)
- Fazy z eq-diagnose: pętla feedbacku → reprodukcja → 3–5 hipotez falsyfikowalnych (HITL: ranking) → instrumentacja (`[DEBUG-xxxx]`) → fix + test regresyjny → cleanup (`metator debug-tags check`).
- **DoD:** przyczyna potwierdzona eksperymentem, test regresyjny, 0 tagów debug.

### W9 `mt-security-advisory`: Dependabot / CVE / GHSA
- Analiza (read-only, z eq-analize-github-issue): identyfikacja → `bun pm ls`/`bun why <pkg>` (ścieżka zależności) → czy podatny kod jest osiągalny (`metator graph callers` na API pakietu) → strategia (bump / override / patch / accept-risk) → plan weryfikacji.
- **DoD:** raport w stałym formacie + rekomendacja. Fix idzie przez W2.

### W10 `metator-knowledge-refresh`: nightly (CI, bez człowieka)
- `metator index build` → `metator cards build` → `metator patterns scan` → `metator memory validate` → `metator docs drift` → `metator rules coverage`.
- **Wyjście:** PR „knowledge refresh” z częścią generowaną + issue z driftem i nieaktualnymi wpisami pamięci.

### W11 `mt-retro`: retrospektywa
- `mt-conversation-analyst` (na `log.md` runów + rozmowie) → propozycje (nowa reguła / wzmocnienie / skill / lesson) **z cytatami** → HITL → zapis do canon albo `docs/metator/lessons/`.
- **DoD:** maks. 10 propozycji, każda z dowodem. Zatwierdzone przeszły `rules lint` / `memory check`.

### W12 `mt-agent-change`: meta-workflow zmiany agentów, skilli i instrukcji
- **Trigger:** PR dotykający `.github/agents|skills|instructions|hooks|metator/workflows`.
- **Etapy:** `metator agents lint` + `skills lint` + `workflow lint` → `metator eval run --affected` (3×) → porównanie z baseline (`metator eval compare`) → raport w PR.
- **DoD:** brak regresji powyżej progu (np. precision −3 pp, recall −5 pp, koszt +20%). Zmiany w progach wymagają CODEOWNERS „AI Platform”.

---

## 4. Audyt istniejących orchestratorów

Twój repo ma już minimalistyczny workflow. Nie przepisujemy go, tylko **mierzymy względem anatomii** i domykamy luki.

### 4.1 Procedura audytu (F0)
1. `metator audit inventory`: lista agentów, promptów, skilli, instrukcji, ADR, z rozmiarami (znaki/tokeny), frontmatterem i referencjami (kto kogo wywołuje).
2. Dla każdego orchestratora wypełnij **kartę zgodności** (poniżej). Ocena 0 = brak, 1 = tylko w prompcie, 2 = wymuszone skryptem lub hookiem.
3. `metator audit graph`: graf wywołań agent → agent/skill. Wykrywa cykle, martwe skille, agentów bez wywołań i zagnieżdżenie > 2.
4. Uruchom 3–5 realnych zadań na obecnym workflow z telemetrią ręczną (czas, liczba poprawek człowieka, błędy wykryte później). To jest **baseline**.
5. Wynik: `docs/metator/audit/AUDIT-<data>.md` z listą luk posortowaną wg (wpływ × łatwość).

### 4.2 Karta zgodności orchestratora

| Sekcja anatomii | Ocena 0/1/2 | Gdzie dziś | Działanie |
|-----------------|-------------|------------|-----------|
| Trigger / entry | | | |
| Kontrakt wejścia | | | |
| Etapy z właścicielem | | | |
| Artefakty ze schematem | | | → schematy w `metator/schemas` |
| Bramki deterministyczne | | | → `metator gate`, `plan lint` |
| Bramki LLM | | | |
| HITL z numerowanymi opcjami | | | |
| Równoległość + limit | | | |
| Limity pętli + eskalacja | | | → `limits` w spec |
| Autonomia L0/L1/L2 | | | → `state.json.autonomy` + hook |
| Uprawnienia (scope, approvals) | | | → hook `pre-tool` |
| DoD | | | → `done` w spec + hook `Stop` |
| Recovery | | | |
| Wznowienie | | | → `metator run status`, `PreCompact` |
| Telemetria | | | → `metator run` loguje automatycznie |
| Raport końcowy | | | |

### 4.3 Typowe „doszlifowania” minimalistycznego orchestratora
1. **Wydziel spec do YAML.** Prompt orchestratora skraca się do zasad delegacji i linku do spec.
2. **Zamień raporty markdown na JSON + krótkie podsumowanie.** Najpierw dla analizy, planu i findings, bo z nich korzystają skrypty.
3. **Dodaj `metator run` i `state.json`.** Daje to wznowienie, audyt i podstawę dla hooków.
4. **Przenieś „MUST” z promptów do hooków i bramek.** Każde „nigdy nie edytuj X”, „zawsze uruchom lint” staje się kodem.
5. **Rozbij review na Find/Verify/Judge** i dołóż schemat znaleziska.
6. **Dodaj allowlisty `agents:` i `user-invocable: false`** dla workerów.
7. **Podepnij evale**, zanim zaczniesz poprawiać prompty. Inaczej nie wiesz, czy poprawka pomogła.
