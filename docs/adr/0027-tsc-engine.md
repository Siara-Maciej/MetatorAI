# ADR-0027: tsc jako silnik E1, włączone reguły narzędzi i wybór silników

- Status: Accepted
- Data: 2026-10-26

## Kontekst
Część reguł projektu wymusza kompilator (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Reguła E1 wskazująca narzędzie jest prawdziwa tylko wtedy, gdy reguła narzędzia jest **włączona**. Do tej pory `rules lint` sprawdzał wyłącznie jej istnienie (ADR-0025, konsekwencje negatywne). Do tego `rules check` uruchamiał każdy silnik, więc samo dodanie adaptera tsc oznaczałoby typecheck w każdym repo z `tsconfig.json`.

## Decyzja
- **`TscEngine`** (`plugin-typescript`, port `RuleEngine`):
  - reguły to logiczne flagi sprawdzeń kompilatora (`strict` i jego rodzina, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnused*` itd.); stan włączenia pochodzi z `tsc --showConfig`, a `strict` włącza swoją rodzinę, chyba że flaga jest jawnie `false`;
  - znaleziska to błędy `tsc --noEmit --pretty false` z kodem (`TS2322`) i pozycją;
  - reguła trzyma się, dopóki flaga jest włączona, a projekt przechodzi typecheck.
- **`EngineRule.enabled`:** silnik, który zna konfigurację repo, podaje, czy reguła jest włączona. Biome odczytuje to z `biome rage --linter` („Enabled rules”), a tsc z `--showConfig`. `rules lint` traktuje regułę E1 wskazującą wyłączoną regułę narzędzia jako błąd, a `rules coverage` wypisuje takie reguły w `e1Disabled`.
- **`rules check` uruchamia tylko silniki, do których kanon wiąże reguły.** Repo z `tsconfig.json`, ale bez reguł `tsc:…`, nie jest tu typecheckowane.
- Dogfood: MT-CODE-008 (`tsc:noUncheckedIndexedAccess`) i MT-CODE-009 (`tsc:exactOptionalPropertyTypes`); E1 = 60%.

## Konsekwencje
### Pozytywne
- Wyłączenie flagi albo reguły Biome, na której opiera się kanon, jest czerwone w CI.
- Brak niechcianych uruchomień narzędzi w repo, które ich nie wybrały.
### Negatywne
- Błędy tsc nie mapują się na pojedyncze reguły kanonu (kod błędu nie wskazuje flagi): raportowane są jako naruszenia silnika `tsc`.
- `biome rage` to narzędzie diagnostyczne; zmiana jego formatu wyłączy rozpoznawanie stanu (wtedy `enabled` nie jest podawane, a testy adaptera to wykryją).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| API kompilatora do odczytu opcji | TS 7 nie ma stabilnego API JS (ADR-0008) |
| Czytanie `tsconfig.json` samodzielnie | `extends`, domyślne wartości i rodzina `strict`; `--showConfig` robi to poprawnie |
| Uruchamianie wszystkich silników w `rules check` | typecheck i lint tam, gdzie nikt o nie nie prosił |

## Implikacje dla kodu
ADR-0027 egzekwują reguły kanonu MT-CODE-008, MT-CODE-009 (`metator rules show <id>`).
