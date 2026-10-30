# ADR-0075: Wyszukiwanie przez powłokę bez pytania człowieka; sekrety blokowane w procesie

- Status: Proposed
- Data: 2026-10-30

## Kontekst
Agenci MetatorAI szukają w kodzie narzędziami Grep i Glob hosta. Na prawdziwym folderze z backendem i frontendem okazało się, że host Claude Code w wersji 2.1.296 tych narzędzi nie ma: sesja dostaje tylko Read i Bash, a szuka się przez `grep` i `find` w powłoce. Każde takie wywołanie trafiało do `canUseTool`:
- w runie pytało człowieka o każde `grep`;
- w `metator ask` było odrzucane.

Przewodnik (`mt-guide`) nie znalazł niczego i odpowiadał, że nie może odpowiedzieć.

Na tym samym folderze wyszły jeszcze dwie rzeczy:
- **Definicja agenta.** Gdy sesja pracuje w folderze, a definicja agenta leży w repozytorium (`projectConfigRoot` jest dla worktree), to ani definicja, ani reguły `deny` z `.claude/settings.json` repozytorium nie obowiązują. Backend blokuje tymi regułami odczyt `.env.secret`.
- **Linki.** Repozytorium podlinkowane do folderu jest dla `grep -r` i `find` puste.

## Decyzja
- **Czysta funkcja domeny `readOnlyCommand(command, dirs)`.** Polecenie uznaje się za wyszukiwanie tylko wtedy, gdy każda jego część czyta:
  - to potok programów `grep`, `egrep`, `fgrep`, `rg`, `ls`, `find`, `cat`, `head`, `tail`, `wc`, `sort`, `uniq`, `cut` lub `tr`;
  - nie ma opcji, które piszą lub uruchamiają (`find -exec`, `-delete`, `-fprint*`, `rg --pre`, `sort -o`);
  - nie ma przekierowań, `;`, `&&`, podstawień `$()` i backticków, zmiennych ani kilku linii;
  - ścieżki leżą w katalogach agenta, bez `..` i `~`.

  Wzorzec wyszukiwania (pierwsze słowo `grep`/`rg` albo wartość `-e`) nie jest ścieżką.
- **Host Claude** przepuszcza takie polecenie bez pytania. Wszystko inne idzie do człowieka, jak dotąd.
- **Sekrety blokuje hook PreToolUse w procesie SDK.** Hook używa tej samej funkcji `secretPath` co `guard pre-tool`, więc odmowa obowiązuje niezależnie od ustawień katalogu, w którym pracuje sesja.
- **Definicja agenta** z `.claude/agents/<agent>.md` repozytorium trafia do sesji jawnie (`agents`), więc działa także w folderze.
- **Prawdziwe miejsca podlinkowanych repozytoriów** `metator ask` podaje przewodnikowi i dodaje do jego katalogów (`dirs`).

## Konsekwencje
### Pozytywne
- Na prawdziwym folderze `metator ask` odpowiada na pytanie o wywołanie endpointu z frontendu do backendu: 10 cytatów `path:line`, wszystkie prawdziwe.
- Recenzenci i weryfikator w runie szukają bez pytania człowieka o każde `grep`.
- Odczyt sekretów jest zablokowany także tam, gdzie ustawienia repozytorium nie działają.

### Negatywne
- Lista programów i opcji to polityka, którą trzeba utrzymywać. Nowa opcja, która pisze, wymaga zmiany listy. Domyślnie wszystko, czego lista nie zna, idzie do człowieka.
- Wyszukiwanie może czytać wszystko w katalogach agenta poza plikami z sekretami, czyli tyle, co Read.

## Implikacje dla kodu
- `readOnlyCommand` i `secretPath` są czystymi funkcjami w `core/domain` (MT-ARCH-001); host tylko je wywołuje.
- Każda zmiana listy programów lub opcji ma test w `read-only-command.test.ts` i mutanta.
