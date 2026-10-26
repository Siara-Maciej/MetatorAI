# ADR-0037: Zgody w runie: `RunRecord` v2 i `run approve`

- Status: Proposed
- Data: 2026-10-26

## Kontekst
Hook `pre-tool` ma blokować push i komentarze bez zgody człowieka (04-commands §F, workflows §2). `RunRecord` v1 zapisywał zgodę tylko jako wpis `APPROVE` w historii etapu HITL. Zgody na akcje spoza etapów (push, komentarz na GitHubie) nie miały gdzie trafić, a hook musiałby przeszukiwać historię.

## Decyzja
- **`RunRecord` v2** dodaje `approvals`: mapę „etap HITL albo akcja → `{by, choice?, at}`”. Akcje to `push` i `comment` (`APPROVAL_ACTIONS`).
- **Migracja v1 → v2:** zgody z wpisów `APPROVE` w historii (`by` z `detail`, `at` = `updatedAt` runu). Przykład v1 w `docs/metator/schemas/RunRecord.v1.example.json` dowodzi migracji (MT-CODE-003).
- **`run approve <gate> --by <kto> [--choice] [--run]`:**
  - bieżący etap: zgoda przechodzi przez maszynę stanów (zdarzenie `APPROVE`), więc etap, który nie jest HITL, odmawia (`TRANSITION_DENIED`);
  - akcja: zapis w `approvals` i w `log.md`, bez zmiany etapu;
  - inna nazwa albo zakończony run: błąd użycia.
- `run advance approve` także zapisuje zgodę w `approvals`; `run status` ją pokazuje.

## Konsekwencje
### Pozytywne
- `guard pre-tool` sprawdza jedno pole, a zgoda ma autora i czas.
- Pierwsza prawdziwa migracja dokumentu przechodzi przez bramkę MT-CODE-003 (snapshot v1 i v2, przykład v1).
### Negatywne
- Zgody z v1 dostają czas ostatniej zmiany runu, nie faktyczny czas decyzji (v1 go nie zapisywał).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Zgoda na push jako etap workflow | push nie jest etapem; workflow bez etapu „delivery” nie mógłby go zatwierdzić |
| Odczyt zgód z historii w hooku | każdy konsument musiałby znać kształt historii |
