# ADR-0042: `Workflow` v2 z anatomią i `workflow lint`

- Status: Proposed
- Data: 2026-10-26

## Kontekst
02-workflows §1 definiuje anatomię: 16 pytań, na które każdy workflow musi odpowiadać (trigger, wejście, warunki wstępne, etapy z właścicielami, artefakty, bramki, równoległość, pętle, eskalacja, autonomia, uprawnienia, DoD, recovery, wznowienie, telemetria, raport). `Workflow` v1 opisywał tylko etapy, bramkę HITL i pętle. Audyt F0 potrzebuje „karty zgodności” orchestratora, a W1–W5 potrzebują pełnej specyfikacji.

## Decyzja
- **`Workflow` v2** dodaje pola anatomii (`entry`, `input`, `preconditions`, `limits.parallel`, `escalation`, `autonomy`, `permissions`, `done`, `recovery`, `resume`, `telemetry`, `report`). Do etapów dochodzą `owner`, `parallel`, `produces`, `gate {script, llm}`, `skipAt`, `neverSkip` i `optional`. Właściciel to id agenta, `skill:<nazwa>` albo `script:<komenda>`.
- Pola są w schemacie opcjonalne, więc każdy plik v1 jest plikiem v2 (migracja to tożsamość). Schemat v1 jest zamrożony i nie zmienił się, łącznie z kolejnością pól; przykład v1 dowodzi migracji (MT-CODE-003). Maszyna stanów runu czyta te same `stages` i `loops`.
- **`workflow lint`** wymaga wszystkich 16 sekcji i sprawdza:
  - każdy etap roboczy ma właściciela;
  - właściciele, workerzy i krytycy LLM są agentami albo skillami z kanonu (skrypty są wolne);
  - `limits.parallel` ≤ 6, a etap nie uruchamia więcej workerów;
  - `skipAt` tylko na etapie HITL i nigdy przy `neverSkip`;
  - poziomy autonomii, na których etap jest pomijany, należą do zadeklarowanych.

  Pętle sprawdza już schemat (powrót bez limitu jest odrzucany).
- `workflow validate` zostaje walidacją schematu; `workflow lint` to karta zgodności z anatomią.

## Konsekwencje
### Pozytywne
- Minimalistyczny orchestrator pilota dostaje listę braków jedną komendą (F0).
- Specyfikacja jest czytana przez skrypt (run, hooki), nie tylko przez model.
### Negatywne
- Sekcje opisowe (`recovery`, `report`) lint sprawdza tylko co do obecności, nie treści.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Anatomia jako pola wymagane w v2 | pliki v1 przestałyby się wczytywać; runy w toku stanęłyby |
| Anatomia w osobnym pliku obok workflow | dwa źródła prawdy o jednym workflow |
