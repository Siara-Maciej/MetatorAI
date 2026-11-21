# ADR-0094: Blokady niebezpiecznych komend: trzy poziomy w jednym miejscu konfiguracji; commit zawsze decyzją osoby

- Status: Proposed
- Data: 2026-11-21

## Kontekst
Decyzja właściciela produktu z rozmowy 2026-11-20/21. Agent rozmowy (ADR-0093) ma wszystkie uprawnienia i pracuje także poza runem, więc blokady muszą działać technicznie, a nie tylko w prompcie.

Stan dzisiejszy:
- Blokuje hook `metator guard pre-tool` (`packages/cli/src/commands/guard.ts`, `GuardPreTool` w `packages/core/src/application/guard.ts`), a polityka jest w domenie: `preToolPolicy` w `packages/core/src/domain/hook.ts` (ADR-0038).
- Lista komend „nigdy” jest zapisana w kodzie (`destructive`): `git push --force` (także `-f` i `--force-with-lease`), `git reset --hard`, `git clean -f`, `rm -r` korzenia, katalogu domowego albo całego drzewa. Konfiguracja jej nie zna.
- Push, PR i komentarze (`externalAction`, `mcpAction`) wymagają zgody tylko w aktywnym runie (`approvals.push`, `approvals.comment`, ADR-0037). Poza runem polityka kończy się na „no active run” i przepuszcza resztę.
- Commit, merge i rebase nie są sprawdzane wcale. Przepisywanie historii inne niż wymuszony push i kasowanie repozytorium też nie.
- Hook odpowiada tylko odmową. Nie pyta: wywołanie, którego nie blokuje, trafia do zwykłych pytań hosta.
- Hosty różnią się dodatkowymi zabezpieczeniami: Claude Code startuje z `--permission-mode default` (`packages/plugin-host-claude/src/claude-interactive-host.ts`), Copilot CLI z `--deny-tool "shell(git push)"` (`packages/plugin-host-copilot/src/copilot-interactive-host.ts`). Hooki obu hostów powstają z jednej listy `HOOK_BINDINGS` (`.claude/settings.json`, `.github/hooks/metator.json`).
- Zgoda osoby ma dziś dwie drogi. Słowo w czacie: agent woła `metator run approve <bramka> --by <kto> --via chat`, co liczy się tylko wtedy, gdy osoba trzyma sesję (`chatApproval`, ADR-0077). Kliknięcie: okno zgody hosta staje się kartą z wyborami (ADR-0091). Obie drogi dotyczą bramek runu i narzędzi hosta, a nie commita.

## Decyzja
- **Blokada techniczna na obu hostach.** Niebezpieczne komendy są blokowane technicznie w Claude Code i w Copilot CLI.
- **Lista w jednym miejscu w konfiguracji.**
- **Trzy poziomy:**
  - **nigdy:** force push, `reset --hard`, `clean -fd`, przepisywanie historii, kasowanie repozytorium;
  - **za zgodą osoby:** commit, push, merge, rebase;
  - **wolno:** reszta.
- **Commit jest zawsze decyzją osoby.**
- **Odblokowanie:** słowo w czacie albo kliknięcie Yes/No. Oba sposoby działają.

## Konsekwencje
- Poza runem kończy się „tryb swobodny” z ADR-0038 dla commita, pusha, merge'a i rebase'a: agent rozmowy ich nie wykona bez zgody osoby.
- Lista przenosi się z kodu (`destructive`, `externalAction`) do konfiguracji. To nowa wersja dokumentu konfiguracji z migracją, a wartości domyślne muszą dać co najmniej dzisiejszą ochronę.
- Oba hosty muszą dawać ten sam skutek dla każdego poziomu. Zabezpieczenia, które ma tylko jeden host (`--deny-tool`, `--permission-mode`), nie mogą być jedyną ochroną (ADR-0098); zestaw zgodności sprawdza blokady na obu.
- Poziom „za zgodą” wymaga pytania, a hook dziś tylko odmawia. Potrzebna jest droga, która zamienia odmowę w pytanie do osoby i przepuszcza komendę po zgodzie.
- Quick (ADR-0093) kończy się niezacommitowanym diffem; commit po obejrzeniu jest osobną decyzją osoby.

## Zastępuje i rozszerza
- Zmienia dwa punkty ADR-0038: lista komend blokowanych zawsze pochodzi z konfiguracji, a poza runem commit, push, merge i rebase wymagają zgody.
- Rozszerza ADR-0037 (zgody `push` i `comment` w runie) o zgodę poza runem i o commit.
- Rozszerza ADR-0007 (model bezpieczeństwa) i korzysta z dróg zgody z ADR-0077 (słowo w czacie) i ADR-0091 (karta z wyborem).
- Niczego nie zastępuje w całości.

## Pytania otwarte
- Klucz i kształt listy w konfiguracji; czy osoba może ją zmieniać tylko w repozytorium, czy też we własnych opcjach, i czy poziom „nigdy” da się w ogóle złagodzić.
- Dokładne wzorce: co jest „przepisywaniem historii” (`commit --amend`, `rebase -i`, `filter-branch`), skoro zwykły rebase jest „za zgodą”; co jest „kasowaniem repozytorium” (`rm -rf .git`, `gh repo delete`, narzędzia MCP).
- Czy `gh` i narzędzia MCP (PR, merge, zapis plików) podlegają tym samym poziomom co komendy gita? Dziś są mapowane na `push` i `comment`.
- Jak technicznie potwierdzić, że słowo w czacie pochodzi od osoby, gdy nie ma runu ani blokady kierowcy, i na jak długo działa zgoda (jedna komenda, jeden commit, cała sesja)?
- Czy zatwierdzenie bramki `delivery` w pełnym workflowie (dziś daje push, a `mt-pr-author` commituje) jest tą decyzją osoby o commicie, czy potrzebna jest osobna zgoda? Co z autonomią, która bramki pomija?
- Czy poziom „nigdy” obowiązuje także wtedy, gdy osoba wprost o to poprosi (dziś: „Ask the user to run it”)?
- Czy hook w Copilot CLI potrafi zapytać, a nie tylko odmówić? Rozstrzygnie to zestaw zgodności (ADR-0098).

## Implikacje dla kodu
Decyzję będą egzekwować MT-CODE-003 (lista w konfiguracji to nowa wersja `MetatorConfig` z migracją i zamrożonym schematem), MT-TEST-003 (mutant dla każdego poziomu i dla obu dróg odblokowania) i MT-TEST-001 (e2e: prawdziwy `metator guard pre-tool` z payloadem commita, pusha i komendy „nigdy”, z runem i bez). Kod zmieni się dopiero po akceptacji; miejsca, których decyzja dotyczy:

- `packages/core/src/domain/hook.ts`: `preToolPolicy`, `destructive`, `externalAction`, `mcpAction`, `chatApproval`.
- `packages/core/src/application/guard.ts`: `GuardPreTool`; `packages/cli/src/commands/guard.ts`.
- `packages/core/src/domain/config.ts`: dokument konfiguracji.
- `packages/plugin-host-claude/src/claude-interactive-host.ts`, `packages/plugin-host-copilot/src/copilot-interactive-host.ts`: zabezpieczenia na poziomie procesu hosta.
