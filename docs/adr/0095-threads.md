# ADR-0095: Wątki: jeden na temat, jedna hierarchia w pasku bocznym, zapis MetatorAI źródłem prawdy

- Status: Proposed
- Data: 2026-11-21

## Kontekst
Decyzja właściciela produktu z rozmowy 2026-11-20/21 (z dopowiedzeniem z 2026-11-21 o zadaniach Backlogu utworzonych z planu).

Stan dzisiejszy:
- Rozmowa jest terminalem. Czat wejścia to panel w `Layout` (`.metator/layout.json`, `packages/core/src/domain/layout.ts`) z sesją hosta; `startedRun` wiąże panel z runem, który z niego wystartował. Po restarcie demona sesja wraca w tym samym panelu po id sesji hosta (ADR-0092). To, o czym była rozmowa, żyje więc tylko w sesji hosta i na ekranie panelu.
- Dokument `Conversation` (`packages/core/src/domain/conversation.ts`, ADR-0058) zapisuje pytania i odpowiedzi `metator ask` z agentem `mt-guide`. Nie obejmuje czatu wejścia ani jego runów.
- Pasek boczny (`packages/desktop/src/components/sidebar.tsx`) pokazuje pracę jako zadania nadrzędne: zadanie systemowe, run z runami potomnymi albo run samodzielny. Zadanie rozwija się do kroków i runów potomnych według repozytoriów. Poziomu rozmowy nie ma; nowy czat otwiera „+ New run”.
- Na starcie sesji agent dostaje od hooka tylko aktywny run i informację o brakującym indeksie (`GuardSessionStart` w `packages/core/src/application/guard.ts`).
- Zadania Backlogu (`Issue`, `packages/core/src/domain/issue.ts`) i obserwowane MR (`.metator/mrs/`, `packages/core/src/application/review-watch.ts`) nie wiedzą, z jakiej rozmowy pochodzą.

## Decyzja
- **Jeden wątek na temat**, jak czaty Copilota w VS Code. Wątek przetrwa zamknięcie aplikacji. Wątek jest osobnym bytem, a nie terminalem.
- **Kto zakłada wątek.** Osoba („+ New chat”) albo agent, który proponuje nowy wątek, gdy temat się zmienia.
- **Pasek boczny: jedna hierarchia.** Wątek → jego zadania → repozytoria → kroki. Zadania spoza rozmowy są w wątku „bez rozmowy”.
- **Źródłem prawdy jest zapis MetatorAI:** podsumowanie wątku, powiązane runy, zadania Backlogu i obserwowane MR. Agent odczytuje ten zapis na starcie sesji.
- **Zadanie Backlogu utworzone z planu jest powiązane z wątkiem, w którym plan powstał** (ADR-0096). Wątek można zamknąć; zadanie żyje dalej i otwiera nowy wątek, gdy zostanie uruchomione.

## Konsekwencje
- Rozmowę da się podjąć po zamknięciu aplikacji i na innym hoście, bo kontekst jest w zapisie MetatorAI, a nie tylko w sesji hosta. To warunek równości hostów (ADR-0098): Copilot CLI nazywa sesje sam i bywa wznawiany jako „ostatnia sesja katalogu”.
- Zapis wątku jest nowym dokumentem wersjonowanym. Pasek boczny dostaje poziom nad zadaniami, a dzisiejsza lista zadań nadrzędnych staje się zawartością wątków.
- Runy, zadania Backlogu i obserwowane MR dostają powiązanie z wątkiem; praca bez wątku (start z formularza, z automatu wejścia, z `metator run new` w terminalu) trafia do wątku „bez rozmowy”.
- Agent rozmowy (ADR-0093) pilnuje grupowania kontekstów: podsumowanie trzeba pisać i odświeżać, co kosztuje limit.
- Zamknięcie wątku nie zamyka pracy: zadanie Backlogu z planu żyje dalej i przy uruchomieniu zakłada nowy wątek.

## Zastępuje i rozszerza
- Rozszerza ADR-0092 (czat jako terminal główny zadania): powiązanie rozmowy z pracą przechodzi z panelu (`startedRun`) na wątek.
- Rozszerza ADR-0080 (`Layout`: workspace, pane): wątek jest bytem ponad panelem.
- Dotyka ADR-0058: `Conversation` zostaje zapisem `metator ask`; relacja do wątku jest pytaniem otwartym.
- Niczego nie zastępuje w całości.

## Pytania otwarte
- Dokument wątku: nazwa, miejsce na dysku, pola ponad wymienione w decyzji; relacja do `Conversation` (ADR-0058) i do panelu w `Layout`.
- Kto i kiedy pisze podsumowanie wątku (agent na końcu tury, demon, hook) i jak długie może być?
- Jak agent odczytuje zapis na starcie sesji tak samo na obu hostach: hook `guard session-start`, prompt, czy komenda `metator`?
- Jeden wątek a sesje hosta: czy ponownie otwarty wątek wznawia sesję hosta po id (ADR-0092), czy zaczyna nową z podsumowaniem? Czy wątek może mieć kilka terminali?
- Zasięg wątku: repozytorium czy folder repozytoriów; gdzie leży zapis wątku, który obejmuje kilka repozytoriów?
- Jak agent rozpoznaje zmianę tematu i w jakiej formie proponuje nowy wątek (pytanie słowami, karta)?
- Czy „+ New chat” zastępuje „+ New run”? Czy zamknięty wątek znika z paska, czy jest archiwizowany?
- Nowy wątek otwarty przez uruchomione zadanie Backlogu: czy dziedziczy podsumowanie wątku, w którym plan powstał?

## Implikacje dla kodu
Decyzję będą egzekwować MT-CODE-002 i MT-CODE-003 (zapis wątku to wersjonowany dokument z zamrożonym schematem; powiązania w `Issue` i w runie to nowe wersje z migracją), MT-TEST-003 (mutanty dla grupowania zadań w wątki) i MT-TEST-001 (e2e: wątek przetrwa restart demona). Przed akceptacją nic w kodzie się nie zmienia. Wątki dotkną:

- `packages/core/src/domain/layout.ts`: `startedRun`; `packages/core/src/domain/conversation.ts`.
- `packages/core/src/application/guard.ts`: `GuardSessionStart`.
- `packages/core/src/domain/issue.ts`, `packages/core/src/application/review-watch.ts`: powiązanie z wątkiem.
- `packages/desktop/src/components/sidebar.tsx`, `packages/desktop/src/tasks.ts`: hierarchia paska bocznego.
