# ADR-0002: Własny mały kontener DI z typowanymi tokenami

- Status: Superseded by [ADR-0011](0011-di-awilix.md)
- Data: 2026-10-25
- Źródło: [ARCHITECTURE.md §7](../ARCHITECTURE.md)

## Kontekst
Potrzebujemy DI dla czystej architektury. CLI i hooki mają budżet startu (hook `pre-tool` p95 < 150 ms) i muszą działać na Node, Bun i jako binarka `bun build --compile`.

## Decyzja
Ręczne wstrzykiwanie przez konstruktor + własny kontener (`packages/runtime/src/container.ts`): typowane tokeny `Token<T>`, leniwe singletony, `override` dla warstw konfiguracji, multi-bindingi dla rejestrów, wykrywanie cykli. Bez dekoratorów i `reflect-metadata`.

## Konsekwencje
### Pozytywne
- Jawny graf zależności w jednym pliku composition root.
- Leniwość: hooki budują tylko to, czego dotykają.
- Zero zależności zewnętrznych.

### Negatywne
- Brak auto-wiring: fabryki pisane ręcznie.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| inversify / tsyringe | dekoratory, `reflect-metadata`, wolniejszy start, gorsza zgodność z bundlowaniem |
| Brak kontenera, tylko ręczne składanie | przy pluginach i nadpisaniach z configu staje się nieczytelne |
