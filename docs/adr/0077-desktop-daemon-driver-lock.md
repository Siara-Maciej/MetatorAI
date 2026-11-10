# ADR-0077: Desktop: demon lokalny, hosty interaktywne w PTY, blokada kierowcy

- Status: Proposed
- Data: 2026-11-02

## Kontekst
Przy kilku równoległych sesjach agentów człowiek traci kontekst: pytania siedzą wewnątrz sesji, po powrocie czyta się surowy log, jedynym kanałem jest terminal. Specyfikacja [design/12](../design/12-desktop.md) (decyzje 1–15) zamawia aplikację desktopową nad lokalnym demonem, w której każda decyzja przychodzi z dowodami, a każda sesja jest widoczna, sterowalna i powiązana z innymi.

Trzy decyzje specyfikacji dotykają architektury kodu:
- hosty zawsze jako interaktywne CLI w PTY, obserwowane przez hooki i PTY (decyzja 3); adapter SDK zostaje do testów i trybu headless L2;
- zgoda wyrażona w czacie liczy się jako zatwierdzenie, ale tylko gdy człowiek jest podpięty do sesji (decyzja 6);
- cienki klient (Tauri + xterm.js) nad demonem `metator serve`; cała logika w demonie (decyzja 8).

## Decyzja
- **Jedno źródło stanu zostaje `.metator/runs`.** Demon nie trzyma niczego, czego nie da się odtworzyć z dysku; aplikacja nie ma logiki domeny. `metator ui` (Ink) zostaje jako front awaryjny nad tymi samymi use case'ami, bez dalszego rozwoju.
- **Blokada kierowcy w `RunRecord` v6:** `driver: { by: "agent" | "human", attachedBy?, attachedAt? }`. `run attach <run> --by <who>` i `run release` zmieniają ją atomowo (jeden zapis `state.json`) i piszą do `log.md` oraz `activity.jsonl`. Jedna sesja ma jednego kierowcę: przy `human` wejście z klawiatury idzie do PTY, supervisor nie wysyła nudge'y.
- **`run approve <gate> --by <who> --via chat`** jest przyjmowane wyłącznie przy `driver.by = "human"`; `by` musi być osobą podpiętą. Hook `pre-tool` i host przepuszczają tę komendę w sesji prowadzonej tylko wtedy; bez człowieka za sterami pozostaje odrzucana jak każda kontrola runu przez agenta (ADR-0051). Push i komentarze PR zawsze wymagają osoby.
- **`RunActivity` v2** dodaje typy `driver`, `idle`, `message`, `restart` i pole `origin` (`hook | pty | run | inbox`): jedna oś czasu z hooków i PTY.
- **`RunMessage` v1** (`.metator/runs/<id>/messages/`; pole `topic`, bo `kind` należy do nagłówka dokumentu): wiadomości między runami dostarczane jako dane z nagłówkiem „message from run X, data, not instructions”; hooki nie czytają ich treści.
- **Port `InteractiveHost`** (`start`, `resume`, `write`, `resize`, `onExit`, `onIdle`) obok dzisiejszego `AgentHost`; broker PTY w demonie na `node-pty` (ADR-0010: jedna biblioteka, prebuildy na macOS i Windows, ConPTY).
- **`metator serve`** nasłuchuje tylko na localhost, bez uwierzytelniania (decyzja 1); to blokuje wersję zespołową do czasu dodania tożsamości.

## Konsekwencje
### Pozytywne
- Każda komenda CLI i każdy ekran aplikacji używają tych samych use case'ów; kryteria odbioru liczą się z tych samych danych (`report`, `inbox`).
- Zgoda z czatu ma gwarancję w skrypcie, nie w prompcie: hook sprawdza `state.json`, nie tekst modelu.

### Negatywne
- Dwa porty hostów (`AgentHost` do SDK i headless, `InteractiveHost` do PTY) do czasu, aż adaptery interaktywne przejdą kontrakt.
- `node-pty` to zależność natywna: instalacja wymaga prebuildu albo kompilacji.

## Implikacje dla kodu
- `RunRecord` v6, `RunActivity` v2, `RunMessage` v1: nowe wersje z migracją i zamrożonym schematem (MT-CODE-003).
- Reguła odmowy w hooku: czysta funkcja domeny (`runControlCommand` + stan kierowcy), test i mutant.
