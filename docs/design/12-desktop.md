# MetatorAI Desktop: specyfikacja produktu i interfejsu

Status: **zatwierdzona do implementacji** (Maciej, 2026-11-02). Dokument zastępuje wcześniejszą analizę w zakresie `metator ui`; część biznesowa (dystrybucja, review w CI, kanon reguł) pozostaje w pliku `metatorai-analiza-biznesowa.md` i wchodzi po tym strumieniu (decyzja 10).

## 0. Projekty graficzne

Źródło prawdy dla każdego widoku to płótno: **https://claude.ai/artifact/UwMe55aX7XYbqUboEVdjkW** (prywatne; udostępnij z menu Share, jeśli ma je zobaczyć ktoś jeszcze). Plansze są klikalne: ikony w szynie i przyciski „Open session”, „New session”, ikona siatki prowadzą między ekranami. Na planszach 2 i „Komponent · panel sesji” działają przełączniki.

| Nr | Plansza na płótnie | Plik źródłowy (HTML, lokalnie) | Co pokazuje |
|---|---|---|---|
| 1 | 1 · Inbox: kolejka decyzji | `metator-ui/project/Main.dc.html` | Główny ekran: kolejka „Needs you” i karta decyzji; panel sesji w trybie App |
| 2 | 2 · Sesja: terminal i zdarzenia | `metator-ui/project/Session.dc.html` | Jedna sesja: blokada kierowcy, przełącznik Terminal / Events, pytanie, aplikacje, zmiany, powiązania |
| 3 | 3 · Graf powiązań | `metator-ui/project/Graph.dc.html` | Tory per repozytorium, strzałki rodzic → dziecko, przerywana „shares invoice.ts”, fale wdrożenia |
| 4 | 4 · Supervisor | `metator-ui/project/Supervisor.dc.html` | Kafle kryteriów odbioru, tabela floty, restarty, polityka, polityki nauczone |
| 5 | 5 · Odprawa po powrocie | `metator-ui/project/Briefing.dc.html` | „Since you left”: oś czasu, decyzje agenta, bramki, czego potrzebuje, dowody |
| 6 | 6 · Nowa sesja | `metator-ui/project/NewSession.dc.html` | Dialog tworzenia sesji z ostrzeżeniem o budżecie uwagi |
| 7 | 7 · Siatka terminali | `metator-ui/project/Terminals.dc.html` | Grupa feature'a jako 2×2 terminali, kafel przypięty spoza grupy; panel sesji w trybie Run |
| K | Komponent · panel sesji | `metator-ui/project/SessionsPanel.dc.html` | Współdzielony panel z przełącznikiem App / Run |

Pliki leżą w `/tmp/claude-0/-home-user-MetatorAI/d455d74f-3a86-5e75-881e-21fb6f54d163/scratchpad/metator-ui/project/`. Nic nie trafiło do repozytorium.

## 1. Problem i cel

Przy kilku równoległych sesjach agentów człowiek traci kontekst: każde pytanie wymaga wejścia w sesję i odtworzenia jej historii, pytania są wewnątrz sesji zamiast w jednej kolejce, po powrocie czyta się surowy log, a jedynym kanałem jest terminal z dzwonkiem. Cel aplikacji: **każda decyzja człowieka jest tania, bo przychodzi z dowodami, a każda sesja jest widoczna, sterowalna i powiązana z innymi.** Zasada produktu bez zmian: LLM decyduje, skrypt mierzy, hook egzekwuje, człowiek zatwierdza.

## 2. Decyzje (zdecydował Maciej, 2026-11-02)

| Nr | Decyzja | Konsekwencja w specyfikacji |
|---|---|---|
| 1 | Narzędzie dla jednej osoby; role i zespół po wdrożeniu | Demon lokalny bez uwierzytelniania; jeden użytkownik |
| 2 | Hosty w kolejności: Copilot CLI, Claude Code, OpenCode | Port `InteractiveHost` od pierwszego dnia; Copilot do kryteriów odbioru, reszta po zielonym kontrakcie |
| 3 | **Zawsze interaktywne CLI w PTY; MetatorAI obserwuje przez hooki i PTY** | Adapter SDK zostaje tylko do testów i trybu headless L2 (CI) |
| 4 | Powiązania: rodzic–dziecko z planu systemowego **oraz** wiadomości między agentami | Dokument `RunMessage` v1, dostarczany jako dane |
| 5 | Człowiek tworzy sesje dowolnie; supervisor utrzymuje je przy życiu; sesje potomne może tworzyć MetatorAI | Supervisor bez własnej polityki rozdziału zadań w v1 |
| 6 | Zgoda wyrażona w czacie liczy się jako zatwierdzenie | Tylko przy blokadzie „kierowca: człowiek” (§5.3) |
| 7 | Windows, macOS, Linux | Bez tmux; broker PTY (node-pty, ConPTY) w demonie |
| 8 | Tauri + xterm.js; cienki klient nad demonem | Cała logika w `metator serve`; aplikacja tylko rysuje |
| 9 | Dwa widoki sesji: surowy terminal i znormalizowane zdarzenia | Jedna oś czasu z hooków i PTY |
| 10 | Ten strumień przed dystrybucją i review w CI | Pierwszy zewnętrzny zespół przesuwa się o kwartał, świadomie |
| 11 | Kryteria odbioru 11a i 11b (§9) | Widoczne jako kafle w Supervisorze |
| 12 | Desktop powstaje, może użyje go ktoś jeszcze | Licencja i dystrybucja aplikacji jako temat późniejszy |
| 13 | Panel sesji z przełącznikiem App / Run; feature rozbity na kilka workflowów jest jedną, wyraźnie oznaczoną grupą | Komponent `SessionsPanel`, pojęcie **grupy feature'a** (§4.4) |
| 14 | Widoki kompaktowe: wiersz listy = tytuł + jedna linia podsumowania | Skala i gęstość w §6.2 |
| 15 | Wiele terminali na jednym ekranie jako siatka | Ekran 7 |

## 3. Architektura

```
┌──────────────────────────── aplikacja Tauri (cienka) ─────────────────────────────┐
│  Inbox · Sesja · Siatka terminali · Graf · Supervisor · Odprawa · Nowa sesja        │
│  xterm.js ×N  ◄── WebSocket (PTY) ──┐      ◄── WebSocket (stan, zdarzenia) ──┐      │
└──────────────────────────────────────┼──────────────────────────────────────────┼──────┘
                                       ▼                                          ▼
┌──────────────────────────── metator serve (lokalny demon) ─────────────────────────┐
│  WorkOverview (sesje, etapy, pytania, powiązania, liczniki)                         │
│  DecisionInbox: karty decyzji ze stanu runu, planu, bramek, logu                    │
│  Broker PTY: 1 PTY na sesję hosta, blokada kierowcy (agent | człowiek)              │
│  Sensor: zdarzenia z hooków + sygnały z PTY → activity.jsonl (jedna oś czasu)       │
│  Supervisor: utrzymuje sesje, restart z resume, próg bezczynności, limit WIP        │
│  Skrzynka wiadomości między runami (RunMessage)                                     │
└───────────────┬───────────────────────────┬───────────────────────────┬─────────────┘
                ▼                           ▼                           ▼
     InteractiveHost: copilot      InteractiveHost: claude     InteractiveHost: opencode
     (PTY + .github/hooks)         (PTY + .claude hooks)       (PTY + wtyczka)
                ▼                           ▼                           ▼
             .metator/runs/<id>/ state.json · log.md · activity.jsonl · plan.json · findings/
```

**Zasady.** Jedno źródło stanu: `.metator/runs`. Demon nie trzyma niczego, czego nie da się odtworzyć z dysku. Aplikacja nie ma logiki domenowej. `metator ui` (Ink) zostaje jako awaryjny front na tym samym demonie, bez dalszego rozwoju. Tryb headless L2 w CI używa adaptera SDK, nie PTY.

### 3.1 Port `InteractiveHost` (zastępuje dzisiejsze znaczenie `AgentHost`)

```
start(task, cwd, env) → { sessionId, pty }      // interaktywne CLI z zadaniem startowym
resume(sessionId, cwd) → { pty }                 // claude --resume, copilot --resume, opencode -s
onExit(code) · onIdle(ms) · write(input) · resize(cols, rows)
```

Adaptery: `copilot` (pierwszy), `claude`, `opencode`, `scenario` (testy, bez sieci). Wspólny zestaw kontraktowy (`packages/testing/src/contracts`): start z zadaniem, wznowienie, pytanie i odpowiedź, wykrycie końca, wykrycie bezczynności, odmowa pushu bez zgody.

### 3.2 Sensor: hooki + PTY

| Źródło | Claude Code | Copilot CLI | OpenCode |
|---|---|---|---|
| przed narzędziem | PreToolUse | `preToolUse` | `tool.execute.before`, `permission.ask` |
| po narzędziu | PostToolUse | `postToolUse` (tylko sukces) | `tool.execute.after` |
| start sesji | SessionStart | `sessionStart` | `session.created` |
| koniec / bezczynność | Stop | **brak**: z PTY | `session.idle` |

Każdy hook dopisuje zdarzenie do `activity.jsonl` (`RunActivity`, nowe typy: `driver`, `idle`, `message`, `restart`). Koniec sesji i bezczynność zawsze potwierdza PTY (wyjście procesu, brak wyjścia przez próg). Błędy narzędzi w Copilocie są widoczne tylko z PTY.

### 3.3 Supervisor

- Utrzymuje sesje z `state.json` o stanie aktywnym; restart z `resume` po wyjściu procesu (limit prób, zapis `restart` w aktywności i w `log.md`).
- Próg bezczynności (domyślnie 90 s): bez wyjścia i bez otwartego pytania → nudge planem kroku; po drugim razie pytanie do człowieka.
- Limit WIP (domyślnie 4): liczba sesji w stanie „czeka na Ciebie”. Powyżej limitu nowe pytania ustawiają się w kolejce skrzynki, a nowe sesje startują z ostrzeżeniem.
- Tworzy sesje potomne z planu systemowego (`system plan run`) i zapisuje relacje w `RunRecord.parent/children`.
- Nie rozdziela zadań sam (decyzja 5).

## 4. Model danych (nowe wersje dokumentów, ADR-0016)

### 4.1 `Question` v2 → karta decyzji

Pola dodane do v1 (`id`, `runId`, `stage`, `source`, `agent`, `prompt`, `options`, `multiSelect`, `askedAt`, `answer`):

| Pole | Treść | Skąd |
|---|---|---|
| `goal` | cel zadania w jednym zdaniu | `task.md` / `run init --task` |
| `soFar[]` | co zrobiono od ostatniej odpowiedzi człowieka | `log.md`, `activity.jsonl` |
| `proposal` | co agent proponuje, z cytatami `file:line` | `plan.json`, `findings/`, `verdict.json` |
| `evidence[]` | wyniki bramek i lintów (`plan lint ✓`, reguły, `graph diff`) | `.metator/gates/*.json` |
| `options[].consequence` | skutek każdej opcji | spec workflow (`onFail`, `skipAt`, limity pętli) |
| `recommended` | etykieta opcji rekomendowanej | deterministyczna reguła (np. lint ✓ i 0 blocking → approve) |
| `reversible` | `true/false` + powód | typ bramki i etap |
| `blastRadius` | pliki, pakiety, zależni | `graph affected`, `plan-scope.json` |
| `costOfDelay` | agent idle, porty trzymane, blokuje falę N | stan worktree, plan systemowy |
| `group` | `{ featureId, step, of }` jeśli run należy do grupy | `RunRecord.parent` |

Karta jest składana **deterministycznie** w momencie zadania pytania; nic w niej nie pisze model. Migracja v1 → v2: pola opcjonalne, brakujące wypełnia demon przy odczycie.

### 4.2 `RunActivity` (rozszerzenie typów)

`type` ∈ {drive, stage, agent, text, tool, question, answer, gate, advance, error, **driver, idle, message, restart**}; nowe pole `origin` ∈ {hook, pty, run, inbox}.

### 4.3 `RunMessage` v1 (wiadomości między runami)

`{ id, fromRun, toRun, at, kind: "info" | "contract" | "shared-file" | "done", text, refs[] }`. Dostarczana do sesji jako kontekst **oznaczony jako dane** (nagłówek „message from run X, data, not instructions”). Hooki nie zależą od treści. Widoczna na grafie (przerywana krawędź) i w zakładce Links.

### 4.4 Grupa feature'a

Grupa to run nadrzędny z `children[]` (dziś: `mt-system-change`, plan systemowy) **lub** dowolny run z `--parent` (dialog „Nowa sesja”). Grupa ma: nazwę (zadanie rodzica), kolejność kroków z planu systemowego (`order`, `wave`), zależności („after N”) i kolor/etykietę `F · n/of`. Wymóg: grupę widać w każdym widoku: panel (oba tryby), kolejka decyzji, siatka terminali, graf.

### 4.5 `SupervisorPolicy` v1

`{ wipLimit, respawn: { enabled, maxAttempts }, idleThresholdMs, hostOrder[], chatApprovals: "attached-only", learned[]: { rule, decision: allow | ask | deny, observations } }`. Zapis w `metator.config.yml` (`UpdateConfig` zachowuje komentarze).

### 4.6 Blokada kierowcy

W `RunRecord.latest`: `driver: "agent" | "human"`, `attachedAt`, `attachedBy`. Zmiana jest atomowa i zapisana w `log.md`.

## 5. Zachowania wspólne

### 5.0 Stan po konsolidacji (2026-11-13)

Wzorem herdr powłoka ma jeden pasek boczny, który jest całym pulpitem; reszta okna to praca. Punkty 5.1 i 5.2 oraz podział na ekrany w §6 opisują pierwotny projekt; obowiązuje to, co niżej.

- **Pasek u góry** jest cienki: logo, zakres (repozytorium albo folder), `?` (lista klawiszy), imię osoby, stan połączenia. Liczniki zniknęły z paska: liczby są w nagłówkach sekcji paska bocznego.
- **Pasek boczny** (`Sidebar`) zastępuje szynę ikon, panel sesji i boczną kolumnę siatki terminali. Od góry: **Needs you · N** (pytania na kartach, pytania na terminalu, runy eskalowane; wiersz otwiera decyzję), **Runs · N** per repozytorium z pane'ami pod runem i krokami rozbitego runu pod rodzicem, **Finished · N** (zwinięte), miejsca niebędące runem (Terminals, Backlog, Reviews, Overview, Settings) i przycisk **+ New run** z drugim **Form…**. Poniżej 1000 px pasek jest szufladą pod przyciskiem **Runs · N**.
- **Jeden wzór wiersza**: glif stanu, nazwa, słowo stanu po prawej, jedna wyciszona linia (etap · host · wiek). Bez chipów w wierszach.
- **Stany runu**: `needs you`, `working`, `escalated`, `done`, `idle`. `done` to run zakończony, którego ta osoba jeszcze nie otworzyła; po otwarciu jest `idle`. Stan zwija się pane → run → repozytorium jedną czystą funkcją (`rollUp` w `src/model.ts`). Stany pane'a bez zmian: `working`, `asks`, `idle`, `exited`. „Otwarte” jest pamiętane w magazynie okna (`metator.seen`), bo `RunOverview` nie niesie czasu ostatniego obejrzenia; po dodaniu pola `seenAt` do `RunOverview` magazyn okna można usunąć.
- **Jedna strona runu** (`#/run/<run>/<zakładka>`) z zakładkami Overview, Terminal, Plan, Changes, Activity (klawisze `o` `t` `p` `d` `l`). Overview to dawna Odprawa (§6.8), Terminal to dawna Sesja (§6.4) bez tabeli zdarzeń, Activity to dawne Events. Stare adresy (`#/session`, `#/plan`, `#/review`, `#/briefing`) prowadzą na właściwą zakładkę. Liczba zmienionych plików w Overview pochodzi z tego samego źródła co zakładka Changes (diff runu).
- **Overview** (`#/overview`) łączy Supervisora (§6.7, zakładka Daemon) i Graf (§6.6, zakładka Dependencies); `#/supervisor` i `#/graph` nadal działają.
- **Słownik**: jednostka pracy to „run” („+ New run”), „session” to tylko żywy proces agenta („Open a session”), „task” to pozycja backlogu, ekran wielu pane'ów to „Terminals”, ekran diffu to „Changes”.
- **Pusty start**: bez żadnego runu obszar główny pokazuje pole „Describe a task” z „Start” i „Use the form”; pane agenta startowego czyta się `idle · ready for your task`, nigdy `asks`.
- **Klawisze**: `?` z filtrem pisanym w polu; `j`/`k` i strzałki w każdej liście (kolejka decyzji, kroki, pliki, zadania); jedna litera ma jedno znaczenie na wszystkich ekranach.

### 5.1 Powłoka ekranu

Pasek u góry: logo, folder repozytoriów, liczniki (need you / driving / escalated), budżet uwagi `n / limit`, szukaj, powiadomienia. Szyna po lewej: Inbox, Sesja, Siatka terminali, Graf, Supervisor, Ustawienia. Panel sesji zawsze widoczny (komponent `SessionsPanel`). Treść widoku po prawej.

### 5.2 Panel sesji (`SessionsPanel`)

- Przełącznik **App / Run**, zapamiętywany per użytkownik.
- **App:** sekcje per repozytorium z licznikiem; wiersz: kropka stanu, tytuł, etykieta `F · n/of` dla kroków grup, linia podsumowania (etap · host · czas).
- **Run:** grupy feature'a jako ramki z etykietą FEATURE, nazwą, postępem `k / of` i falą; kroki ponumerowane, złączone „then” / „then · wave 2”, z „after N”; sekcja STANDALONE; CONVERSATIONS; złożone „▸ N finished”.
- Sortowanie w obu trybach: czeka na Ciebie → pracuje → zatrzymany → eskalowany → gotowy.
- Stopka: „+ New session”, ikona siatki (otwiera zaznaczoną grupę jako siatkę terminali).
- Klawisz `g`: następna sesja, która czeka.

### 5.3 Kierowca sesji i zgody z czatu

- Jedna sesja ma w danej chwili jednego kierowcę: agent (PTY pisze tylko host) albo człowiek (attach: wejście z klawiatury idzie do PTY).
- Attach wstrzymuje automatyczne nudge'e supervisora i zapisuje `driver: human`.
- Zgoda z czatu: agent po usłyszeniu zgody wywołuje `metator run approve <gate> --by <user> --via chat`; hook `pre-tool` przepuszcza wyłącznie przy `driver: human` i zapisuje w `log.md`, kto był podpięty. Bez człowieka za sterami ta sama komenda jest odrzucana jak dziś.
- Push i komentarze PR zawsze wymagają osoby, na każdym poziomie autonomii.

### 5.4 Powiadomienia

Powiadomienie systemowe (Tauri) przy nowym pytaniu i eskalacji; treść = nagłówek karty decyzji. Kanały Slack/Teams poza zakresem v1 (decyzja 1), ale karta ma kształt wiadomości z przyciskami, więc dojdą jako cienka warstwa.

## 6. Specyfikacja widoków

### 6.1 Wspólne reguły wizualne

- Ciemny motyw. Tło `#0E1117`, panel `#151A22`, hover `#1B222C`, krawędź `#273040`, tekst `#E6E9EF`, wyciszony `#9AA4B2`, pomocniczy `#8A94A6` (min. 4.5:1).
- Stany, zawsze z różnicą jasności, nie tylko barwy: bursztyn `#F0B429` czeka na Ciebie, fiolet `#A78BFA` agent pracuje, czerwony `#F87171` eskalacja, zielony `#4ADE80` gotowe, szary zatrzymany, niebieski `#60A5FA` człowiek / grupa feature'a / wiadomość. Teal `#2DD4BF` tylko dla akcji.
- Czcionki: Inter (UI), JetBrains Mono (terminal, ścieżki, komendy).
- Dostępność: prawdziwe `<button>`, `<a>`, `<input>` z etykietami; `aria-current`, `aria-pressed`; cele dotykowe ≥ 28 px w kompaktowej skali, ≥ 44 px dla akcji głównych.

### 6.2 Gęstość (zatwierdzona)

| Element | Wartość |
|---|---|
| bazowy rozmiar tekstu | 12.5 px, interlinia 1.4 |
| pasek u góry / szyna | 44 px / 52 px |
| wiersz listy | tytuł 12.5 px 600 + jedna linia 11 px wyciszona; padding 5–6 px |
| nagłówek widoku | 13–15 px; tytuł karty decyzji 17 px |
| karty i kafle | padding 8–10 px, promień 8 px |
| chipy | 10–11 px, padding 1–3 px × 6–8 px |
| terminal | 11.5–12.5 px mono, interlinia 1.55 |

### 6.3 Ekran 1 · Inbox: kolejka decyzji (plansza 1)

**Cel.** Pusta skrzynka = koniec pracy. Odpowiedź bez wchodzenia do sesji.

**Układ.** Panel sesji (App) · kolumna „Needs you” (280–320 px) · karta decyzji.

**Kolumna „Needs you”.** Pozycje posortowane po koszcie zwłoki (agent idle, porty, blokada fali). Każda: typ (GATE / PERMISSION / QUESTION), etykieta grupy `F · n/of` jeśli dotyczy, tytuł, czas oczekiwania, jedna linia: run · repo · 2–3 chipy (reversible, blast radius, policy candidate, blocks wave). Pod listą pozycja informacyjna „N escalated” z linkami do Odprawy i Terminala (eskalacja nie jest pytaniem).

**Karta decyzji.** Z `Question` v2: identyfikator i kontekst (q, bramka, repo, workflow, autonomia, host); tytuł; linia chipów: reversible, blast radius, waiting + koszt, loops; „Since you left”; plan lub propozycja z exemplarami i dowodami; trzy opcje jako kafle ze skutkami i etykietą RECOMMENDED; przyciski: główna akcja (teal), alternatywa, „Reject…” (czerwony tekst), pole notatki; stopka z komendą, która zostanie zapisana (`metator run approve … --by …`).

**Interakcje.** `⏎` wykonuje rekomendację po potwierdzeniu; `a` odpowiedz; `o` otwórz sesję; `g` następna. Odpowiedź wysyła `run answer` / `run approve`; karta znika z kolejki, licznik budżetu uwagi spada.

**Kryterium.** 80% decyzji z karty bez otwierania sesji (mierzone: odpowiedź bez wcześniejszego attach ani otwarcia ekranu 2 dla tego pytania).

### 6.4 Ekran 2 · Sesja (plansza 2)

**Układ.** Panel sesji · obszar sesji · prawy panel szczegółów (260–320 px).

**Nagłówek sesji.** Tytuł, `runId` mono, chipy: repo, workflow, autonomia, host, porty, czas. Pasek etapów: `intake ✓ ─ context ✓ ─ plan ✓ ─ [build ⟳] ─ gates · ─ review · ─ delivery ·`.

**Pasek kierowcy.** `Driver: you · attached N min` (niebieski) albo `Driver: agent` (fiolet). Tekst wyjaśnia, że zgody z czatu działają tylko przy blokadzie. Przycisk `Release to agent · c` / `Attach · a`.

**Przełącznik Terminal / Events.** Terminal = xterm.js podpięty do PTY (do odczytu bez attach, pisanie po attach). Events = tabela TIME · TYPE · SOURCE · WHAT z `activity.jsonl` (hook / PTY / run / inbox). Przyciski: Editor `e`, Shell `t`, Diff `d`.

**Pole wiadomości.** Mono, podpowiedź skrótów (`y / a / p / n`), aktywne tylko przy attach; bez attach klik wywołuje attach.

**Prawy panel.** Pytanie (opcje: Allow once · Always for this run · **Make it a policy** · Deny), Apps worktree (usługi, porty, start/stop/logi), Changes (pliki, +/−), Links (rodzic, wiadomości, ostrzeżenie o wspólnym pliku z sugerowaną kolejnością scalania).

### 6.5 Ekran 7 · Siatka terminali (plansza 7)

**Cel.** Feature rozbity na kilka sesji widoczny i sterowalny z jednego ekranu.

**Nagłówek.** Etykieta FEATURE, nazwa grupy, „N sessions in order · + M pinned”, przełącznik układu `1 / 2×2 / 3×3`, „Follow: next that needs you”, „+ Add session”.

**Kafel.** Pasek: numer kroku (kolor stanu), tytuł, repo · host · „after N”, stan i kierowca, `Attach` / `Release`, rozwiń do ekranu 2. Treść: terminal tylko do odczytu; po attach pole wpisywania i `Send`. Kafel spoza grupy ma przerywaną ramkę i przycisk odepnij. Kafel z fokusem ma ramkę teal.

**Zasady.** Co najwyżej jeden kafel z `driver: you` naraz (jedna klawiatura, jeden PTY). „Follow” ustawia fokus na pierwszej sesji w stanie „czeka na Ciebie”. Układ i skład siatki zapamiętywany per grupa.

### 6.6 Ekran 3 · Graf powiązań (plansza 3)

Tory per repozytorium (liczniki runów), sesje jako karty w kolorze stanu, strzałki ciągłe rodzic → dziecko (teal) z etykietami „child · deploy wave N”, przerywane bursztynowe dla wiadomości i wspólnych plików. Prawy panel: lista linków z akcjami (`Merge X first`, `Notify both`), fale wdrożenia planu systemowego ze stanem, nota o wiadomościach jako danych. Dane: `RunRecord.parent/children`, `RunMessage`, przecięcie `graph affected` między worktree (ostrzeżenie o konflikcie przed scalaniem).

### 6.7 Ekran 4 · Supervisor (plansza 4)

Nagłówek: stan demona, liczba sesji i hostów, uptime, adres `metator serve`. Akcje: Spawn session, Pause all, Attention mode. Cztery kafle = kryteria odbioru (§9). Tabela floty: sesja, repo, host, kierowca, stan, uptime, restarty, bezczynność, ostatnia aktywność. „Restarts and nudges · today”. Prawy panel: `SupervisorPolicy` (limit WIP suwak, restart z resume, próg bezczynności, kolejność hostów, zgody z czatu: tylko attach, push: zawsze osoba) i polityki nauczone z odpowiedzi (reguła, decyzja, liczba obserwacji, próg awansu).

### 6.8 Ekran 5 · Odprawa po powrocie (plansza 5)

Nagłówek „Since you left · N min” z kontekstem runu i przyciskami „Open terminal and attach”, „Mark as read”. Kafle: etapy (z pętlami), decyzje agenta, pliki zmienione, bramki teraz. Oś czasu pogrupowana po etapach: zdarzenia, decyzje agenta z powodem i exemplarem, restarty, pętle bramek z przyczyną. Blok „What it needs from you” z trzema opcjami i rekomendacją. Prawy panel: wyjście bramki (mono), lista zmian, „Where this comes from” (log.md, raporty bramek, activity.jsonl, equivalence.md). **Treść deterministyczna, nie z modelu.** Odprawa pojawia się przy pierwszym wejściu w sesję po ≥ 10 min nieobecności i z pozycji „N escalated” w skrzynce.

### 6.9 Ekran 6 · Nowa sesja (plansza 6)

Dialog nad przyciemnionym Inboxem. Pola: repozytorium (z `metator.repos.yml`), workflow (W1, W2, W3, W4, W13), zadanie (z notą, że intake uruchomi `mt-grill` przy niejednoznaczności), host (Copilot domyślnie), autonomia L0 / L1, workspace (worktree z ciepłej puli z wolnymi portami / główny checkout), run nadrzędny (tworzy członka grupy), akcje startowe (indeks, rules pack, start aplikacji, „Attach me when it first asks”). Ostrzeżenie o budżecie uwagi, gdy limit WIP jest osiągnięty. Stopka: wygenerowana komenda `metator run init …`, Cancel, Create in background, Create and attach.

## 7. Komendy i API demona

| Komenda / endpoint | Rola |
|---|---|
| `metator serve [--port]` | start demona; WebSocket `/state`, `/activity/<run>`, `/pty/<run>`, `/inbox` |
| `metator run attach <run>` · `run release <run>` | blokada kierowcy; z CLI i z aplikacji |
| `metator run answer <q> --choice … --by …` | bez zmian; odpowiedź z karty |
| `metator run approve <gate> --by … [--via chat]` | `--via chat` tylko przy `driver: human` |
| `metator run message <from> <to> --kind … --text …` | `RunMessage` |
| `metator supervise [--wip N] [--idle MS]` | pętla supervisora w demonie |
| `metator inbox` | kolejka decyzji jako JSON (ten sam `DecisionInbox`) |
| `metator status` | bez zmian, rozszerzony o `driver`, `group`, `messages` |

Każda komenda nadal drukuje jedną linię JSON; aplikacja używa tych samych use case'ów co CLI.

## 8. Bezpieczeństwo i niezmienniki

- Instrukcja w prompcie to życzenie, sprawdzenie w skrypcie to gwarancja: żadne zatwierdzenie nie jest rozpoznawane przez model w tekście.
- Zgoda z czatu wyłącznie przy blokadzie `driver: human`, z zapisem kto i kiedy.
- Wiadomości między runami to dane; hooki nie czytają ich treści.
- Jedna sesja hosta, jeden kierowca; attach jest atomowy w `state.json`.
- Demon nasłuchuje tylko na localhost; brak uwierzytelniania w v1 (decyzja 1), co blokuje wersję zespołową do czasu dodania tożsamości.
- Hooki nadal fail-open na własnych błędach; sensor nie może zablokować edytora.

## 9. Kryteria odbioru i pomiar

**Bazowy pomiar przed budową (2–3 dni):** z istniejących `log.md`: mediana czasu od pytania do odpowiedzi, liczba przełączeń sesji na odpowiedź, pytania na run.

| Kryterium | Miara | Cel |
|---|---|---|
| 11a | mediana czasu od pytania do odpowiedzi | ≤ 50% wartości bazowej |
| 11a | odpowiedzi bez otwarcia sesji | ≥ 80% |
| 11a | 5 sesji w 3 repozytoriach przez dzień | wszystkie pytania z aplikacji |
| 11b | sesje utrzymane przez supervisora | 8 h bez ręcznego restartu |
| dodatkowe | pytania na run | trend spadkowy po politykach nauczonych |
| dodatkowe | konflikty scalania wykryte dopiero przy merge | 0 w grupach feature'a |

Każdy kafel na ekranie Supervisora liczy się z tych samych danych, więc kryterium jest widoczne na co dzień.

## 10. Plan realizacji (ok. 12–14 tygodni, jedna osoba z agentami)

| Krok | Zakres | Czas | Kryterium wyjścia |
|---|---|---|---|
| 0 | Pomiar bazowy; spike Copilot CLI w PTY z `--resume`, nagrane payloady hooków interaktywnych | 1 tydz. | liczby bazowe; wiadomo, czy próg bezczynności wystarczy jako koniec sesji |
| 1 | `metator serve`: WorkOverview, DecisionInbox, broker PTY z blokadą, sensor z hooków, `run attach/release` | 2–3 tyg. | e2e: pytanie z PTY trafia do skrzynki, odpowiedź wraca do PTY; attach blokuje drugiego kierowcę |
| 2 | Port `InteractiveHost` + adapter Copilot + scenariusz; zestaw kontraktowy | 1–2 tyg. | kontrakt zielony na Copilot i scenariuszu |
| 3 | Supervisor: respawn, bezczynność, limit WIP, sesje potomne; `SupervisorPolicy` v1 | 1–2 tyg. | 8 h na hoście scenariuszowym z wstrzykiwanymi awariami |
| 4 | `RunMessage` v1, przecięcia `graph affected` między worktree | 1 tydz. | e2e: dwa runy na wspólnym pliku dostają ostrzeżenie i kolejność scalania |
| 5 | Aplikacja Tauri: ekrany 1, 2, 7, K, potem 3, 4, 5, 6; powiadomienia systemowe | 5–6 tyg. | kryteria 11a i 11b na Copilocie |
| 6 | Adaptery Claude Code i OpenCode na tym samym kontrakcie | po kroku 5 | kontrakt zielony |

Testowanie wg AGENTS.md: unit na każde zachowanie, e2e na prawdziwym procesie w repo tymczasowym, kontrakt na każdy adapter, mutant na moduł, `bun run check` zielony. Na końcu dokumentacja użytkownika w `site/`.

## 11. Ryzyka

| Ryzyko | Skutek | Zabezpieczenie |
|---|---|---|
| Copilot CLI bez hooka końca sesji; `postToolUse` tylko po sukcesie | supervisor nie wie, kiedy restartować; błędy narzędzi niewidoczne | PTY jako drugie źródło: wyjście procesu, próg bezczynności, wzorce błędów |
| Format hooków Copilota zmienia się między wersjami | sensor przestaje pisać | payloady w fixtures, test kontraktowy w CI, degradacja do samego PTY |
| Zgoda z czatu obchodzi bramki | utrata gwarancji audytu | tylko przy `driver: human`, zapis w `log.md` |
| Trzy hosty w jednym kwartale | żaden dopracowany | Copilot do kryteriów odbioru, reszta po zielonym kontrakcie |
| Tauri + ConPTY na Windows | rendering terminali hostów | spike xterm.js + node-pty na Windows w pierwszym tygodniu kroku 5 |
| Dwa fronty (Ink i Tauri) rozjeżdżają się | podwójna praca | Ink zamrożony, tylko nad demonem |
| Przesunięcie dystrybucji o kwartał | brak zewnętrznego użytkownika | decyzja 10 świadoma; aplikacja jako nowe wejście do produktu |

## 12. Poza zakresem v1

Role i zespół, zdalne odpowiadanie, Slack/Teams, uwierzytelnianie demona, polityka rozdziału zadań przez supervisora, kolejne języki programowania, serwer MCP, dystrybucja npm. Wracają po pierwszym pilocie.

## 13. Źródła przeglądu rynku

- GitHub Docs: Copilot CLI hooks reference, https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference
- GitHub Docs: What are hooks?, https://docs.github.com/en/copilot/concepts/customizations/hooks
- OpenCode hook tutorial, https://learnopencode.com/en/5-advanced/12c-hooks
- OpenCode advanced plugins, https://learnopencode.com/en/5-advanced/12b-plugins-advanced
- Codacy: parallelization strategy for AI coding agents 2026, https://blog.codacy.com/does-your-engineering-team-have-a-parallelization-strategy-for-ai-coding-agents-2026
- Nimbalyst: tools for running parallel AI coding agents, https://nimbalyst.com/blog/best-tools-for-running-parallel-ai-coding-agents/
- Munder Difflin: tools to run multiple Claude Code agents, https://munderdiffl.in/blog/best-claude-code-multi-agent-tools/
- Superset: Conductor vs Crystal, https://superset.sh/compare/conductor-vs-crystal
- GitHub Blog: Introducing Agent HQ, https://github.blog/news-insights/company-news/welcome-home-agents/
- VentureBeat: GitHub's Agent HQ and the enterprise problem, https://venturebeat.com/ai/githubs-agent-hq-aims-to-solve-enterprises-biggest-ai-coding-problem-too
- Implicator.ai: only 26% of companies can track AI costs, https://www.implicator.ai/only-26-of-companies-can-track-what-their-ai-costs.md
- heyvaldemar: agent sprawl as a 2026 engineering risk, https://heyvaldemar.com/agent-sprawl-2026-engineering-risk/
