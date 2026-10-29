# ADR-0011: DI: awilix

- Status: Accepted
- Data: 2026-10-25

## Kontekst
Potrzebujemy DI dla czystej architektury: dynamiczne pluginy włączane z konfiguracji, nadpisania (config > preset > default), scope na run workflow, szybki start hooków, zgodność z Bun i `bun build --compile`. Zastępuje [ADR-0002](0002-di-container.md) (własny kontener).

## Decyzja
**awilix 13** w trybie `InjectionMode.PROXY` i `strict: true`. Porty opisuje typowany interfejs `Cradle`. Jedyna nasza warstwa to `resolvePort()`, które zamienia `AwilixResolutionError` na `MetatorError` (`BINDING_MISSING` z podpowiedzią albo `INTERNAL` przy cyklu). Pluginy rejestrują implementacje przez `container.register({...})`. Każdy run dostaje `createScope()`.

## Konsekwencje
### Pozytywne
- Leniwość, scope'y, wykrywanie cykli i ochrona przed wyciekiem lifetime bez własnego kodu.
- Bez dekoratorów: czysty TS, szybki start.

### Negatywne
- Rozwiązywanie po nazwach z cradle zamiast symboli: literówka w nazwie wychodzi dopiero przy `resolve` (łagodzone typem `Cradle` i testami kontraktowymi).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| inversify, tsyringe | dekoratory i `reflect-metadata`, wolniejszy start |
| typed-inject | świetne typy w czasie kompilacji, ale trudne przy dynamicznych pluginach, brak multi-bindingów |
| Własny kontener (ADR-0002) | duplikuje dojrzałą bibliotekę |

## Implikacje dla kodu
ADR-0011 egzekwują reguły kanonu MT-ARCH-006, MT-ARCH-007, MT-CODE-005 (`metator rules show <id>`).
