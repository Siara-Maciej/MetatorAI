# ADR-0051: CLI prowadzi run (`AgentHost`, `run drive`, `RunActivity`, `Question`)

- Status: Accepted
- Data: 2026-10-27

## Kontekst
Dotąd run prowadził koordynator LLM w hoście (Claude Code, Copilot), a człowiek po `run init` sam wpisywał `run advance` i `run approve`. Ciągły, interaktywny run w CLI (F8.4) i sesje w UI (F8.6) wymagają odwrócenia sterowania: CLI prowadzi etapy, a host jest silnikiem agentów. Plan i decyzje: [design/09 §3.5 i §8](../design/09-workspaces-sessions.md). Szkic `run drive`: [06-running.md §B3](../design/06-running.md#b3-szkic-metator-run-drive).

## Decyzja
- **Port `AgentHost`** (`id`, `run(task, ask)` → strumień zdarzeń `session`, `text`, `tool`, `result`).
  - Zadanie: agent, prompt, katalog pracy (worktree runu albo repo), korzeń projektu z plikami hosta, katalog runu, sesja do wznowienia.
  - Pytania agenta i prośby o zgodę idą do `ask`.
  - Kontrakt w `packages/testing`: sesja pierwsza, dokładnie jeden wynik na końcu, słowa agenta jako `text`.
- **Adaptery** (oba hosty od razu, decyzja 1):
  - `ClaudeAgentHost` na Claude Agent SDK (`query`):
    - kanoniczny agent jako główny wątek (`agent`), z `.claude/` projektu (`settingSources: ["project"]`) i `projectConfigRoot` dla worktree;
    - `AskUserQuestion` i każda prośba o zgodę (`canUseTool`) stają się pytaniami do człowieka;
    - `resume` wznawia sesję.

    SDK jest duży (zawiera Claude Code), więc ładuje się leniwie, dopiero gdy run używa tego hosta.
  - `CopilotAgentHost`:
    - `copilot -p … --agent <id> -C <worktree> --add-dir <run> --output-format json --session-id|--resume`;
    - tryb promptu wymaga `--allow-all-tools`, a `--deny-tool shell(git push)` blokuje push na poziomie procesu; hooki działają jak zawsze;
    - flagi potwierdzone w `copilot --help` 1.0.104.

    Format JSONL jest czytany tolerancyjnie (tekst z `content`, narzędzie z `toolName`); do potwierdzenia na prawdziwym wyjściu w spike'u F0. Copilot w trybie promptu nie pyta, więc worker pyta linią `STATUS: blocked: …`.
  - `ScenarioAgentHost` (nowy pakiet `plugin-host-scenario`) odtwarza dokument **`AgentScenario` v1**: kroki `say`, `write`, `tool`, `ask`, `fail`. n-ty start agenta gra n-ty wpis, ostatni się powtarza. Prowadzi całe workflowy bez modelu: testy, dema, CI workflowów.
- **`DriveRun`** (`run drive`):
  - etap HITL to pytanie „Approve / Reject”: odrzucenie jest FAIL z powodem człowieka;
  - etap roboczy po kolei:
    1. skrypty (`script:`) przez `ProcessRunner` z `hosts.metatorCommand`, z `{runDir}` w treści oraz `METATOR_RUN` i `METATOR_RUN_DIR` w środowisku;
    2. agenci w kolejności;
    3. workerzy `parallel` razem;
    4. sprawdzenie artefaktów `produces` w katalogu runu;
    5. `gate.script`;
    6. krytyk `gate.llm` (`VERDICT: PASS` albo `FAIL: …`; brak linii to FAIL, nigdy ciche przejście).
  - Worker kończy linią `STATUS: done` albo `STATUS: blocked: <pytanie>`. Blokada to pytanie do człowieka, a odpowiedź wraca do wznowionej sesji agenta (najwyżej 3 rundy).
  - Każde przejście robi dalej `run advance` albo `run approve`, więc pętle, limity i eskalacje decyduje ta sama maszyna stanów. Po stanie końcowym drive pisze `summary.json` (`run close`).
  - Sesja hosta trafia do runu (`host`, `hostSession`, `RunRecord` v3).
- **Dokumenty w katalogu runu:**
  - `RunActivity` v1: `activity.jsonl`, jeden wersjonowany obiekt na linię;
  - `Question` v1: `questions/qNNN.json`, odpowiedź w tym samym pliku;
  - `RunDriver` v1: `driver.json`, pid, host, start.

  Komunikacja między procesami idzie przez pliki: drive w tle czeka na odpowiedź (port `Timer`), a człowiek odpowiada z innego procesu (`run answer`). Daemon nie jest potrzebny (decyzja 2). Każde pytanie ma opcję `Other` na własne słowa. Wznowiony drive nie pyta drugi raz o to samo otwarte pytanie.
- **`RunDrivers`:** jeden żywy proces prowadzi run, a martwy nie blokuje.
  - `run drive --detach` startuje proces w tle (port `BackgroundProcess`). Log idzie do katalogu tymczasowego systemu, bo w `.metator/` są tylko dokumenty wersjonowane.
  - `run stop` kończy proces; run zostaje na swoim etapie i można go poprowadzić dalej.
- **Komendy:** `run drive [--host] [--detach] [--max-steps]`, `run stop`, `run questions [--all]`, `run answer <q> --choice … [--text] --by`, `run activity [--tail]`.
- **Specyfikacje W1–W5 (revision 2)** używają `{runDir}` w skryptach (`plan lint {runDir}/plan.json`, `findings validate {runDir}/findings`), które koordynator LLM też rozumie. `api snapshot` bez pakietu robi snapshot każdego pakietu workspace'u (etap snapshot w W3).

## Konsekwencje
### Pozytywne
- Ten sam workflow, ci sami agenci i hooki działają w trybie interaktywnym (host prowadzi) i w trybie CLI (CLI prowadzi). Stan jest wspólny, więc run można zacząć w jednym trybie i skończyć w drugim.
- Cały przebieg da się przetestować e2e bez modelu (scenariusz), na prawdziwym repo i prawdziwych procesach.
### Negatywne
- Hooki `guard` w worktree szukają runu w worktree; reguły zakresu planu dla edycji w worktree pilnuje dziś głównie prompt i zgody (`canUseTool`). Pełne powiązanie hooków z runem prowadzonym z CLI to dalszy krok.
- Format JSONL Copilot CLI nie jest udokumentowany; adapter czyta go ostrożnie i wymaga potwierdzenia na prawdziwym hoście.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Daemon z gniazdem lokalnym | dodatkowy proces do zarządzania; pliki wystarczą, przetrwają restart i są audytowalne |
| `claude -p --output-format stream-json` zamiast SDK | zgody i pytania wymagałyby własnego serwera MCP (`--permission-prompt-tool`); SDK daje `canUseTool` |
| Koordynator LLM jako jedyny prowadzący | brak ciągłego widoku w CLI i odpowiedzi z innego procesu; kolejność etapów zależna od modelu |

## Implikacje dla kodu
ADR-0051 egzekwują reguły kanonu MT-ARCH-008, MT-TEST-002 (`metator rules show <id>`).
