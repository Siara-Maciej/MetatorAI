# ADR-0082: Polityka Copilot Memory: co wolno zapamiętać, co jest kanonem

- Status: Proposed
- Data: 2026-11-10

## Kontekst
GitHub Copilot (czat, coding agent, natywne review) zapamiętuje fakty o repozytorium i preferencje osoby między sesjami („Copilot Memory”). MetatorAI ma własną, wersjonowaną pamięć: kanon reguł (`docs/metator/rules/`, E1 egzekwowane narzędziami), karty modułów, wzorce, mapę pamięci (`docs/metator/memory-map.yml`, ADR-0021) i lekcje z cytatami (`docs/metator/lessons/`, ADR-0044). Dwie pamięci o tym samym repozytorium rozjadą się: wspomnienie Copilota może powtarzać regułę, która zmieniła się w kanonie, albo utrwalić wyjątek, którego nikt nie zatwierdził. Roadmapa (F6) wymaga polityki: co wolno, i jak przeglądać konflikty z kanonem.

## Decyzja
- **Kanon jest jedynym źródłem reguł i decyzji.** Wspomnienie Copilota nigdy nie jest regułą: jeśli mówi, jak pisać kod w tym repozytorium, to albo jest już w kanonie (wtedy jest zbędne), albo jest propozycją (wtedy przechodzi drogę W7/W11: cytat → `metator rules scaffold` albo `metator lessons add` → HITL → kanon).
- **Co wolno zapamiętać:** preferencje osoby wobec narzędzia (język odpowiedzi, format, ulubione komendy), fakty o środowisku pracy (który host, jaka maszyna), bieżący kontekst zadania. **Czego nie:** konwencji kodu, granic architektury, decyzji z ADR, „wyjątków od reguły”, sekretów i danych z `.env*`.
- **Instrukcje mówią to wprost.** `.github/copilot-instructions.md` (warstwa lekka, T1 w mapie pamięci) zaczyna się od odesłania do kanonu; wygenerowane `.github/instructions/mt-*` (warstwa ciężka) mają `excludeAgent: code-review`, więc natywne review czerpie z nich tylko to, co kanon mówi dziś, a nie z zapamiętanych skrótów.
- **Przegląd konfliktów:** raz na kwartał, w przeglądzie z `metator meta quarterly`, osoba prosi Copilota o wypisanie zapamiętanych faktów o repozytorium i porównuje je z `metator rules show` oraz `docs/metator/lessons/`. Każdy fakt, który jest regułą kodu, albo trafia do kanonu, albo zostaje usunięty z pamięci Copilota; różnice zapisuje się jako lekcje z cytatem.
- **Pamięć dzielona między osobami** (organizacyjna) nie zawiera nic o kodzie poza linkiem do `AGENTS.md`; wszystko inne jest w repozytorium i wersjonowane.

## Konsekwencje
- Pozytywne: jedna prawda o kodzie, sprawdzalna narzędziami (`rules check`, `memory check`, `docs drift`); wspomnienia Copilota nie starzeją się razem z kodem, bo nie dotyczą kodu.
- Negatywne: osoba musi odmówić Copilotowi „zapamiętania” reguły i zamiast tego wnieść ją do kanonu; to jeden krok więcej, ale jedyny, który zostawia ślad do przeglądu.

## Implikacje dla kodu
- Nic w kodzie MetatorAI nie czyta pamięci Copilota (nie ma do niej API); polityka żyje w tym ADR, w `.github/copilot-instructions.md` i w kwartalnym przeglądzie (`metator meta quarterly`).
