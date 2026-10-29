# ADR-0001: Capabilities i providery

- Status: Accepted
- Data: 2026-10-25
- Źródło: [ARCHITECTURE.md §1](../ARCHITECTURE.md)

## Kontekst
Workflowy, agenci i skille muszą działać w dowolnym repo (różne package managery, lintery, test runnery, hosty AI). Wpisanie konkretnych narzędzi do promptów i specyfikacji wiąże produkt z jednym stackiem.

## Decyzja
Workflowy odwołują się wyłącznie do **capabilities** (`lint`, `format`, `typecheck`, `test`, `rules`, `graph`, `vcs`, `code-host`, `tracker`, `engine`…). Konkretne narzędzie (**provider**) wiąże `metator.config.ts`, wspierany przez detekcję w `metator init`. Wiązanie odbywa się w jednym miejscu: composition root.

## Konsekwencje
### Pozytywne
- Podpięcie nowego repo to konfiguracja, nie zmiana workflow.
- Nowe narzędzie to preset albo plugin, rdzeń bez zmian (OCP).

### Negatywne
- Dodatkowa warstwa pośrednia do zrozumienia przy debugowaniu.
- Wymaga dobrego `metator doctor`, żeby wiązania nie psuły się po cichu.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Komendy narzędzi wprost w specach | wiąże workflow ze stackiem, łamie DIP |
| Jeden uniwersalny port `ToolPort.run(any)` | God-interface, łamie ISP i LSP |

## Implikacje dla kodu
ADR-0001 egzekwują reguły kanonu MT-ARCH-005, MT-ARCH-007, MT-ARCH-008 (`metator rules show <id>`).
