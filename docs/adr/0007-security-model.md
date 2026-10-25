# ADR-0007: Model bezpieczeństwa: allowlista komend i jawne pluginy

- Status: Proposed
- Data: 2026-10-25
- Źródło: [ARCHITECTURE.md §15](../ARCHITECTURE.md)

## Kontekst
Agent z uprawnieniem do shella może wykonać cokolwiek. Treść PR i issue może zawierać prompt injection.

## Decyzja
Agent dostaje uprawnienie wyłącznie do `metator …`. `metator` wykonuje tylko komendy zmaterializowane z konfiguracji i presetów włączonych pluginów. Pluginy ładowane wyłącznie z listy `plugins`, spoza `@metator/*` tylko przez `trustedPlugins`. Zapisy zewnętrzne (komentarze, push) za dekoratorem polityki `ApprovalGatedWriter`. Rdzeń bez sieci. Treści z PR, issue i docs to dane, nie instrukcje.

## Konsekwencje
### Pozytywne
- Bezpieczeństwo wynika z konstrukcji, a nie tylko z promptów.

### Negatywne
- Każde nowe narzędzie musi przejść przez preset/plugin, nie da się go „szybko odpalić” przez agenta.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Poleganie na uprawnieniach hosta | różne per host i per wersja, łatwe do rozszczelnienia |
