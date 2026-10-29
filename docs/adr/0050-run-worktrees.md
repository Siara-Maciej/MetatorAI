# ADR-0050: Worktree runu i bloki portów (`WorktreeRegistry`, `RunRecord` v3)

- Status: Accepted
- Data: 2026-10-27

## Kontekst
Run, który zmienia kod w working tree człowieka, blokuje jego pracę, a dwa runy naraz przeszkadzają sobie: pliki, branch i porty aplikacji są wspólne. Plan F8.2: [design/09 §3.2](../design/09-workspaces-sessions.md).

## Decyzja
- **Port `WorktreeManager`** (`add`, `remove`, `isDirty`), adapter `GitWorktreeManager` na simple-git (`git worktree add -b`, `remove [--force]`; git sam usuwa wpis worktree, którego katalog skasowano ręcznie). Kontrakt w `packages/testing` przechodzą adapter git (prawdziwe repo) i fake.
- **Port `PortProbe`**, adapter `GetPortProbe` na `get-port` (MIT): port jest wolny, gdy get-port zwraca dokładnie go. get-port sprawdza też IPv6, a na hoście bez IPv6 ten test rzuca wyjątkiem, więc adapter wtedy sprawdza wszystkie interfejsy IPv4.
- **`WorktreeRegistry` v1** (`.metator/worktrees.json`) zapisuje id, ścieżkę, branch, bazę, run i blok portów `{ from, count }`.
  - Worktree: `.metator/wt/<id>` na branchu `metator/<id>`.
  - Bloki: z zakresu 41000–48999 (nad typowymi portami deweloperskimi, pod zakresem efemerycznym), wyrównane do rozmiaru (domyślnie 20).
  - Blok jest wydany, gdy nie nachodzi na blok innego worktree i każdy jego port jest wolny na maszynie.
- **Bez plików `.env` w worktree.** Porty są w rejestrze i w odpowiedzi `worktree new` (`METATOR_WORKTREE`, `METATOR_PORT_BASE`, `METATOR_PORT_COUNT`). `env up` (F8.5) przekaże je procesom jako zmienne. Plik wpisany do worktree byłby niezatwierdzoną zmianą w kodzie użytkownika i nie byłby dokumentem wersjonowanym.
- **Treść worktree nie jest dokumentem MetatorAI.** Test wersjonowania (`findUnversioned`) pomija `.metator/wt/**`; rejestr i stan runu są wersjonowane jak wszystko inne.
- **Bezpieczeństwo pracy:**
  - `worktree rm` odmawia przy niezapisanych zmianach bez `--force`;
  - `worktree prune` usuwa tylko worktree runów zakończonych (albo usuniętych) starsze niż N dni i pomija brudne (`keptDirty`);
  - branch zostaje po usunięciu worktree.
- **`run init --worktree [--base <ref>]`** tworzy worktree o id runu i zapisuje go w runie. **`RunRecord` v3** dodaje opcjonalne pola, wszystkie w jednej migracji (decyzja z design/09):
  - `worktree` (F8.2);
  - `host` i `hostSession` (F8.3, wznowienie sesji hosta);
  - `parent` i `children` (F7.6, runy powiązane).

  Migracja v2 → v3 jest tożsamością; v1 przechodzi przez v2 jak dotąd.
- `FileSystem` dostaje `remove(path)` (brakujący plik to nie błąd); kontrakt portu to sprawdza.

## Konsekwencje
### Pozytywne
- Kilka runów naraz, każdy z własnym kodem, branchem i portami; working tree człowieka jest nietknięty.
### Negatywne
- `.metator/` musi być w `.gitignore`, inaczej katalog z worktree jest widoczny jako nieśledzony w głównym checkoutcie (opisane na stronie).
- Stan runu zostaje w głównym checkoutcie; agent w worktree woła `metator -C <główne repo>` (prowadzenie runu przez CLI w F8.3 przekazuje to sam).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Osobny klon na run | pełna kopia historii i obiektów; worktree dzieli `.git` |
| Worktree obok repo (`../repo.wt/<id>`) | poza korzeniem, który widzi port `FileSystem`; trudniejsze sprzątanie |
| Plik `.env` w worktree | niezatwierdzona zmiana w kodzie użytkownika; brak wersjonowania |
| Własny test wolnego portu na `node:net` | ADR-0010: `get-port` to sprawdzony pakiet |

## Implikacje dla kodu
ADR-0050 egzekwują reguły kanonu MT-CODE-002, MT-CODE-003 (`metator rules show <id>`).
