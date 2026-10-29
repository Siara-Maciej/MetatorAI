# ADR-0008: Graf importów przy TypeScript 7 (natywny kompilator)

- Status: Accepted
- Data: 2026-10-25
- Źródło: [ARCHITECTURE.md §6.3, design/04-commands.md §5.1](../ARCHITECTURE.md)

## Kontekst
Bieżąca wersja `typescript` na npm to 7.x (natywny kompilator). Główny eksport pakietu nie udostępnia już klasycznego API (`ts.preProcessFile`, `ts.resolveModuleName`), na którym opierał się szkic grafu importów. Nowe API jest oznaczone jako niestabilne (`typescript/unstable/*`).

## Decyzja
> Aktualizacja: ekstrakcję i rozwiązywanie importów przejął oxc ([ADR-0017](0017-imports-oxc.md)). Część o `tsc` CLI pozostaje w mocy.

Graf importów nie zależy od API kompilatora TS. Ekstrakcja importów idzie przez **ast-grep** (już w stacku, wielojęzyczny), a rozwiązywanie ścieżek przez własny resolver na podstawie `tsconfig` (`paths`), `package.json#exports` i mapy pakietów workspace. Typecheck (`tsc --noEmit`) i snapshot API (`--emitDeclarationOnly`) korzystają z CLI `tsc`, nie z jego API.

## Konsekwencje
### Pozytywne
- Brak zależności od niestabilnego API.
- Ten sam mechanizm działa dla innych języków.

### Negatywne
- Własny resolver musi obsłużyć `exports`/`paths` poprawnie: wymaga testów na fixture'ach.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Pin `typescript@5` dla API | rozjazd z wersją w repo użytkownika |
| `typescript/unstable/sync` | niestabilne API, ryzyko łamania przy aktualizacjach |

## Implikacje dla kodu
ADR-0008 egzekwują reguły kanonu MT-CODE-005, MT-CODE-006 (`metator rules show <id>`).
