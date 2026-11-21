# ADR-0098: Hosty: Copilot CLI na równi z Claude Code, wspólny zestaw zgodności

- Status: Proposed
- Data: 2026-11-21

## Kontekst
W rozmowie 2026-11-20/21 właściciel produktu postawił Copilot CLI na równi z Claude Code. Ostatnie przebiegi na prawdziwym hoście (ADR-0091, ADR-0092) były robione w Claude Code; kalibracja Copilota na prawdziwym hoście jest otwarta od ADR-0080.

Stan dzisiejszy:
- Oba hosty mają adapter `InteractiveHost` na wspólnej bazie `PtyInteractiveHost`, ale startują inaczej:
  - Claude Code (`packages/plugin-host-claude/src/claude-interactive-host.ts`): `claude <zadanie> --session-id <uuid>`, wznowienie `--resume <uuid>`, `--permission-mode default`. Id sesji nadaje MetatorAI.
  - Copilot CLI (`packages/plugin-host-copilot/src/copilot-interactive-host.ts`): `copilot -i <zadanie>`, `--deny-tool "shell(git push)"`. Copilot nazywa sesje sam, więc wznowienie to `--resume <id>` tylko wtedy, gdy id jest UUID, a inaczej `--continue` (ostatnia sesja katalogu).
- Kontrakt portu (`packages/testing/src/contracts/interactive-host.contract.ts`, MT-TEST-002) działa na zastępczym skrypcie powłoki, a nie na prawdziwym CLI. Sprawdza dwie rzeczy: start z zadaniem i rozmowę przez PTY oraz wznowienie po id. Pytania o zgodę, pytania tekstem, hooków ani blokad nie sprawdza.
- Hooki obu hostów powstają z jednej listy `HOOK_BINDINGS` (`packages/core/src/domain/hook.ts`): `.claude/settings.json` i `.github/hooks/metator.json`. Czytanie okna zgody z ekranu (`readHostPrompt`, ADR-0091) opisano na przykładzie menu Claude Code.
- Domyślna kolejność hostów to `copilot`, `claude`, `opencode` (`supervisor.hostOrder` w `packages/core/src/domain/config.ts`).
- Stan faktyczny 2026-11-21: Copilot CLI 1.0.114 jest zainstalowany w środowisku chmurowym, ale nie da się w nim zalogować (sesja GitHuba jest związana z repozytorium, a `api.githubcopilot.com` jest zablokowane).

## Decyzja
- **Copilot CLI jest kluczowy; żadnych różnic względem Claude Code.**
- **Jeden zestaw zgodności dla obu hostów:** start, wznowienie po id, pytanie o zgodę, pytanie tekstem, hooki, blokady. Obie strony przechodzą ten sam zestaw.
- **Funkcji, którą ma tylko jeden host, nie używamy.**
- **Kto uruchamia.** Właściciel uruchomi zestaw zgodności u siebie, bo w środowisku chmurowym Copilot CLI nie daje się zalogować.

## Konsekwencje
- Każda funkcja z ADR-0093 do ADR-0097 musi działać na obu hostach albo nie powstaje. Dotyczy to szczególnie blokad (ADR-0094), pytań słowami i kart (ADR-0091), wznowienia po id (ADR-0092) oraz „przekaż” i „przerwij” (ADR-0093).
- Dzisiejsze różnice adapterów (`--session-id` i `--permission-mode` tylko w Claude Code, `--deny-tool` i `--continue` tylko w Copilot CLI) trzeba sprawdzić zestawem i albo znaleźć odpowiednik po drugiej stronie, albo z nich zrezygnować.
- Zestaw wymaga prawdziwych, zalogowanych CLI, więc nie zadziała w CI ani w środowisku chmurowym. Do czasu przebiegu u właściciela zgodność Copilot CLI jest niepotwierdzona: prac z etapów 1–3 nie da się w środowisku chmurowym sprawdzić na Copilot CLI.
- Zestaw zgodności jest ostatni w kolejności wdrożenia (ADR-0093), więc różnice mogą wyjść dopiero po zbudowaniu funkcji. Im wcześniej właściciel uruchomi choćby część zestawu, tym mniej poprawek.

## Zastępuje i rozszerza
- Rozszerza ADR-0077 (port `InteractiveHost`) i ADR-0080 (hosty wymienne) o wymóg równości i wspólny zestaw zgodności; zamyka pozycję „kalibracja Copilota na prawdziwym hoście” z ADR-0080 dopiero po przebiegu zestawu.
- Rozszerza ADR-0030 (agenci kanoniczni i generatory hostów) i ADR-0038 (hooki obu hostów).
- Niczego nie zastępuje w całości.

## Pytania otwarte
- Gdzie żyje zestaw i jak się go uruchamia: rozszerzenie `interactive-host.contract.ts` o prawdziwe CLI, osobne testy e2e włączane ręcznie, czy komenda `metator`? Jak zapisać wynik przebiegu, żeby dało się go sprawdzić bez logowania?
- Które z dzisiejszych różnic (`--session-id`, `--permission-mode`, `--deny-tool`, `--continue`, czytanie menu zgody z ekranu) są „funkcją jednego hosta”? Rozstrzygnie to pierwszy przebieg zestawu.
- Kto decyduje o rezygnacji z funkcji, gdy przebieg pokaże różnicę, i czy brakującą funkcję wolno zastąpić własnym mechanizmem MetatorAI zamiast z niej rezygnować?
- Czy OpenCode (trzeci w `supervisor.hostOrder`, `packages/plugin-host-opencode`) i host scenariuszowy podlegają tej samej zasadzie? Decyzja wymienia dwa hosty.
- Najniższe wspierane wersje obu CLI (odnotowano Copilot CLI 1.0.114) i co robi MetatorAI, gdy zainstalowana wersja nie przechodzi zestawu.
- Czy środowisko chmurowe ma dostać logowanie do Copilota (odblokowanie `api.githubcopilot.com`), czy zestaw zostaje tylko na maszynie właściciela?

## Implikacje dla kodu
Decyzję będą egzekwować MT-TEST-002 (adapter portu z zestawem kontraktowym uruchamia go; zestaw zgodności rozszerza kontrakt `InteractiveHost`) i MT-TEST-003 (mutanty adapterów obu hostów). Adaptery i kontrakt zmienią się po akceptacji i po pierwszym przebiegu zestawu; dotyczy to:

- `packages/plugin-host-claude/src/claude-interactive-host.ts`, `packages/plugin-host-copilot/src/copilot-interactive-host.ts`.
- `packages/testing/src/contracts/interactive-host.contract.ts`.
- `packages/core/src/domain/hook.ts`: `HOOK_BINDINGS`; `packages/core/src/domain/host-manifest.ts`: `readHostPrompt`.
- `packages/core/src/domain/config.ts`: `supervisor.hostOrder`.
