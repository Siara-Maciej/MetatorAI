# Silniki i CI: Copilot, Claude Code, self-hosted runner

> Status: kierunek na F4–F5. Na teraz domyślny jest tryb interaktywny ([06-running](06-running.md)).

## 1. Jeden kanon, dwa silniki

MetatorAI traktuje GitHub Copilot i Claude Code jako **silniki** tej samej architektury. Wszystko, co niesie wartość, jest od nich niezależne. Różnią się tylko adaptery generowane z kanonu.

| Element | Copilot | Claude Code | Przenośność |
|---------|---------|-------------|-------------|
| Komendy `metator`, reguły ast-grep/Biome, tsc, testy | – | – | 100% (zwykły CLI) |
| Spec workflow (YAML), schematy, `.metator/runs/`, `state.json` | – | – | 100% |
| Canon: ADR, reguły, wzorce, karty modułów, mapa pamięci | – | – | 100% |
| Skille `SKILL.md` | `.github/skills/` | `.claude/skills/` | ten sam standard; Copilot czyta też `.claude/skills` |
| Instrukcje zawsze ładowane | `copilot-instructions.md`, `AGENTS.md` | `CLAUDE.md` z `@AGENTS.md` | wspólny `AGENTS.md` |
| Instrukcje dla ścieżek | `.instructions.md` (`applyTo`) | `.claude/rules/*.md` (`paths`) | generowane z canon |
| Agenci | `.github/agents/*.agent.md` | `.claude/agents/*.md` | generowane z formatu kanonicznego |
| Hooki | `.github/hooks/*.json` | `hooks` w `.claude/settings.json` | logika w `metator guard`, kodeki per host |
| Headless | `copilot -p --agent …` | `claude -p … --output-format json --allowedTools …` | `metator run drive --engine copilot\|claude` |

## 2. Dwa sposoby uruchomienia w CI

1. **Prowadzi agent.** GitHub Action (np. `anthropics/claude-code-action`) uruchamia koordynatora, a on deleguje do subagentów. To prostsze, ale kolejność etapów pilnuje model (z kontrolą skryptów i hooków).
2. **Prowadzi skrypt (rekomendowane).** `metator run drive --engine claude` przechodzi przez spec etap po etapie. Każdy worker działa w osobnym procesie z wąskim `--allowedTools` i `--max-turns`. Po każdym etapie: walidacja artefaktu i `metator run advance`. Zamiast procesów CLI można użyć Claude Agent SDK.

```yaml
- run: bun install && npx metator index build
- run: npx metator run init --workflow review --input "pr:${{ github.event.number }}" --autonomy L2
- run: npx metator run drive --run latest --engine claude
  env: { ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }} }   # albo Bedrock / Vertex
```

### Na co uważać
- **Bramki HITL w CI:** drive zatrzymuje się na `awaiting-approval` (dokończenie lokalnie przez `/mt-resume`), albo zgoda przychodzi komentarzem na PR (`/metator approve G4b 1`), albo workflow jest ograniczony do L2 (tylko review i raporty). Push i merge zawsze wymagają człowieka.
- **Finder ≠ verifier:** samo Claude Code ma jedną rodzinę modeli. Rozwiązania: verifier na innym modelu Claude + wymagany dowód wykonywalny dla blocking, albo silnik mieszany (finderzy przez Copilot CLI, verifier przez Claude).
- **Dostęp do modelu:** klucz API albo dostawca chmurowy (Bedrock, Vertex). To decyzja security i data residency.
- **Koszt:** `--max-turns`, timeouty, limit równoległych procesów, limity pętli ze spec. Telemetria runu pokazuje koszt.
- **Uprawnienia, trzy warstwy:** `--allowedTools` / `permissions`, hook `metator guard pre-tool`, uprawnienia joba (`contents: read`, `pull-requests: write`).

## 3. Self-hosted runner w Dockerze (zero minut CI)

Workflowy mogą działać na własnej maszynie: zarejestrowany **self-hosted runner GitHub Actions** w kontenerze, a w workflow `runs-on: [self-hosted, metator]`.

- **Minuty:** GitHub nie liczy minut dla self-hosted. Zapowiadana opłata za self-hosted w repo prywatnych (marzec 2026) została wstrzymana, ale warto sprawdzać aktualny cennik.
- **Koszt modeli zostaje:** tokeny i premium requests to główny koszt, nie minuty.

```dockerfile
FROM ubuntu:24.04
ARG RUNNER_VERSION=2.xxx.x            # aktualna wersja z github.com/actions/runner/releases
RUN apt-get update && apt-get install -y curl git jq unzip ca-certificates nodejs npm && useradd -m runner
USER runner
WORKDIR /home/runner
RUN curl -fsSL https://bun.sh/install | bash \
 && curl -fsSL -o r.tgz https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz \
 && tar xzf r.tgz && rm r.tgz
ENV PATH="/home/runner/.bun/bin:/home/runner/.npm-global/bin:$PATH"
RUN npm config set prefix ~/.npm-global && npm i -g @ast-grep/cli @anthropic-ai/claude-code @github/copilot
COPY --chown=runner entrypoint.sh .
ENTRYPOINT ["./entrypoint.sh"]
```

```bash
#!/usr/bin/env bash
# entrypoint.sh: runner efemeryczny (jeden job, potem wyrejestrowanie)
set -euo pipefail
TOKEN=$(curl -fsS -X POST -H "Authorization: Bearer $GH_ADMIN_TOKEN" \
  https://api.github.com/repos/$REPO/actions/runners/registration-token | jq -r .token)
./config.sh --unattended --ephemeral --replace --url "https://github.com/$REPO" --token "$TOKEN" \
  --name "metator-$(hostname)" --labels metator,docker
exec ./run.sh
```

```yaml
# docker-compose.yml
services:
  metator-runner:
    build: .
    restart: always          # po każdym jobie: nowy, czysty runner
    env_file: .env.runner    # REPO, GH_ADMIN_TOKEN, ANTHROPIC_API_KEY lub CLAUDE_CODE_OAUTH_TOKEN, COPILOT_GITHUB_TOKEN
    deploy: { replicas: 2 }
    mem_limit: 8g
    cpus: 4
```

### Bezpieczeństwo
1. Tylko repo prywatne albo bez PR-ów z forków. Self-hosted runner wykonuje kod z PR na Twojej maszynie.
2. Runner efemeryczny, bez montowania `/var/run/docker.sock`.
3. Sekrety tylko w `.env.runner` na hoście. Lepiej token GitHub App niż osobisty PAT.
4. Rejestrowanie prywatnego komputera dla repo firmowego może wymagać zgody security.
5. Maszyna musi być włączona, inaczej joby czekają w kolejce i po czasie przepadają.

**Wariant bez GitHub Actions:** kontener z cronem, który sprawdza nowe PR-y (`gh pr list`) i odpala `metator run drive`. Taniej i prościej, ale bez natywnych checków na PR.
