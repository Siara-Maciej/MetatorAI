# ADR-0013: Maszyna stanów runu: XState v5

- Status: Proposed
- Data: 2026-10-25

## Kontekst
Workflow to maszyna stanów: etapy, bramki HITL, pętle z limitami, eskalacja, przerwanie. Stan musi się serializować do `state.json` i wznawiać w innej sesji, CI albo na innym hoście AI.

## Decyzja
**xstate 5**. `RunStateMachine` kompiluje spec workflow (`stages`, `onFail.goto/loop`, `hitl`, `loops`) do maszyny XState. Przejścia przez czyste `initialTransition()`/`transition()` (bez aktorów i efektów ubocznych). Odtwarzanie stanu przez `machine.resolveState({ value, context })`, a sprawdzanie dozwolonych zdarzeń przez `snapshot.can(event)`. Odrzucone zdarzenie zwraca `TRANSITION_DENIED` z podpowiedzią. Bramka HITL akceptuje tylko `APPROVE`, więc agent nie zatwierdzi sam siebie.

## Konsekwencje
### Pozytywne
- Standardowy, dobrze udokumentowany model maszyn stanów; możliwość wizualizacji (Stately) i rozszerzeń (równoległe stany, akcje).
- Czyste funkcje: łatwe testy i wznawianie z JSON.

### Negatywne
- Generowanie konfiguracji maszyny ze spec wymaga rzutowania typów stanów (XState waliduje kształt przy tworzeniu, a testy pokrywają zachowanie).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| robot3 | mniejszy, ale słabszy ekosystem i typowanie |
| Własna maszyna stanów | duplikuje dojrzałą bibliotekę |
