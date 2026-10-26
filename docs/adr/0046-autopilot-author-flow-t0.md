# ADR-0046: autopilot, Author/Reviewer flow i T0 ≤ 4000 znaków

- Status: Proposed
- Data: 2026-10-26

## Kontekst
- **Autopilot.** `Workflow` v2 (ADR-0042) opisuje, na jakim poziomie autonomii bramkę HITL wolno pominąć (`skipAt`) i której nigdy (`neverSkip`), ale maszyna stanów tego nie wykonywała. W bramce planu 06-running przewiduje wybór „Autopilot (L1 do końca runu)”.
- **Author/Reviewer flow.** Review własnego PR-a ma dawać listę poprawek, nie komentarze autora do samego siebie.
- **T0.** `AGENTS.md` miał 7,7 tys. znaków przy celu 4000 (F2).

## Decyzja
- **Pomijanie bramek.** `RunStateMachine.skippable(state, autonomy)` jest prawdziwe dla aktywnej bramki HITL, której `skipAt` zawiera poziom runu i która nie ma `neverSkip`. `run init` i `run advance` zatwierdzają takie bramki po kolei: zgoda `by: "autonomy L1"` trafia do `approvals`, a do logu linia `skipped at L1`.
- **Autopilot.** `run approve <stage> --choice autopilot` (albo `run advance approve --choice autopilot`) podnosi run z L0 do L1. Workflow, który deklaruje `autonomy` bez L1, odrzuca ten wybór. Poziom L2 się nie zmienia. Akcje zewnętrzne (push, komentarz) nie są etapami: `guard pre-tool` dalej wymaga `run approve push|comment`.
- **Author flow.** `findings to-github --role author` nie zwraca komentarzy inline. Blokery trafiają do podsumowania jako lista poprawek dla W5 (`mt-self-review`). Domyślnie `--role reviewer`: komentarze tylko dla potwierdzonych blokerów, jak dotąd.
- **T0.** Główny `AGENTS.md` (Copilot i Claude Code czytają go zawsze) ma ≤ 4000 znaków: komendy, granice architektury, reguły wspólne, dowodzenie pracy, praca narzędziami MetatorAI. Szczegóły warstw i pakietów są w `packages/*/AGENTS.md`, w pozycji `t1.package-agents` mapy pamięci z budżetem 1500 znaków. Budżet T0 w mapie: 4000. Linki reguł kanonu wskazują nowe nagłówki.

## Konsekwencje
### Pozytywne
- L1 działa tak, jak opisuje spec, a ślad pominięcia jest w `state.json` i `log.md`.
- Mniej kontekstu ładowanego zawsze; reguły pakietu czyta się przy pracy w pakiecie.
### Negatywne
- Ustalenie, czy PR należy do użytkownika, zostaje po stronie agenta (`--role`); nie czytamy API hosta.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Pomijanie bramek w hooku zamiast w `run advance` | hook nie zapisuje stanu; run czekałby na bramce, której nikt nie zatwierdzi |
| Osobny `copilot-instructions.md` | drugi plik T0 o tej samej treści; Copilot czyta `AGENTS.md` |
