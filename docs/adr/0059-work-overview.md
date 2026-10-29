# ADR-0059: Przegląd pracy: `metator status` (`WorkOverview`)

- Status: Accepted
- Data: 2026-10-28

## Kontekst
Do zarządzania kilkoma runami człowiek potrzebuje w jednym miejscu kilku rzeczy: gdzie jest każdy run, kto ma ruch, na co trzeba odpowiedzieć, co się ostatnio stało, w jakim worktree i z jakimi usługami run pracuje. Dotąd te dane były rozsiane po `run list`, `run questions`, `run activity`, `worktree list` i `env status`, a `metator ui` (F8.6) liczył część z nich w CLI ([design/10 §3.3](../design/10-repos-ask-tui.md)).

## Decyzja
- **Domena (`overview.ts`, czyste funkcje):**
  - `stageProgress`: każdy etap workflowu to `done`, `current` (pracuje agent albo skrypt), `waiting` (musi zadziałać człowiek), `next` albo `stopped` (run eskalowany lub przerwany);
  - `attentionOf`: kto ma ruch, czyli `you` (otwarte pytanie albo bramka bez drive'a), `driving`, `stopped`, `done`, `escalated` lub `aborted`;
  - `byAttention`: najpierw to, co czeka na człowieka, potem najświeższe, a przy remisie nowszy run, żeby lista w UI nie migotała;
  - `countAttention`: liczniki.
- **Use case `WorkOverview`:**
  - dla każdego runu podaje etapy, kto ma ruch, otwarte pytania z kontekstem, hosta, ostatnią aktywność, czas trwania, worktree z blokiem portów i usługi tego worktree;
  - do tego rozmowy `metator ask` i liczniki;
  - brak środowiska albo usunięty worktree oznacza po prostu brak usług, a nie błąd.
- **`metator status`:**
  - w repozytorium zwraca przegląd;
  - w folderze repozytoriów zwraca przegląd każdego repozytorium, rozmowy folderu i sumy (`FOLDER_COMMANDS` zawiera `status`).
- TUI (`metator ui`, ADR-0060) czyta te same dane, więc wszystko, co widać na ekranie, da się sprawdzić bez terminala.

## Konsekwencje
### Pozytywne
- Jedno źródło prawdy dla CLI, TUI i skryptów (np. powiadomienia w CI albo na czacie).
- e2e:
  - run doprowadzony przez drive do bramki: `you`, z etapami `done → waiting → next` i pytaniem `gate`;
  - run bez drive'a: `stopped`;
  - rozmowa i sumy, także w folderze.
### Negatywne
- Każde wywołanie czyta stan wszystkich runów. Przy setkach runów trzeba będzie filtrować aktywne albo cache'ować (na razie niepotrzebne).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Liczenie stanu w TUI | to samo trzeba by liczyć drugi raz dla skryptów i testów |
| Nowy dokument z zapisanym przeglądem | przegląd wynika ze stanu runów; zapis by się rozjeżdżał |

## Implikacje dla kodu
ADR-0059 egzekwują reguły kanonu MT-ARCH-001, MT-TEST-001 (`metator rules show <id>`).
