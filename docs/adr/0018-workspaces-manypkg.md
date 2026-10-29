# ADR-0018: Pakiety workspace: @manypkg/get-packages

- Status: Accepted
- Data: 2026-10-25

## Kontekst
Graf musi klasyfikować krawędzie jako wewnątrz pakietu albo między pakietami, a komenda `workspace list` ma pokazać pakiety monorepo. Formaty workspace różnią się między npm, yarn, pnpm (`pnpm-workspace.yaml`), bun, lerna i rush.

## Decyzja
**@manypkg/get-packages** w adapterze `ManypkgWorkspaceReader` (`packages/plugin-node`, port `WorkspaceReader`). Jedyny dodatek: manypkg rozpoznaje narzędzie po lockfile'u, więc w repo z `workspaces`, ale bez lockfile'a, rozwijamy zadeklarowane globy sami (`Bun.Glob`). Repo bez `package.json` zwraca pustą listę, pojedynczy pakiet zwraca `dir: "."`.

## Konsekwencje
### Pozytywne
- Obsługa wszystkich popularnych menedżerów pakietów bez własnego parsera.
### Negatywne
- Fallback bez lockfile'a to mała własna logika, pokryta testami.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Własne czytanie `workspaces` | nie obsługuje pnpm, lerna, rush; duplikuje bibliotekę |
| @pnpm/find-workspace-packages | tylko pnpm |

## Implikacje dla kodu
ADR-0018 egzekwują reguły kanonu MT-CODE-005, MT-ARCH-005 (`metator rules show <id>`).
