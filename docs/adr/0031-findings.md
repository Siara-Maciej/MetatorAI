# ADR-0031: Znaleziska review: schemat, polityka dowodów i walidacja cytatów

- Status: Accepted
- Data: 2026-10-26

## Kontekst
Review agentowe „halucynuje” cytaty i linie, a znaleziska bez dowodu blokują PR-y bez powodu ([research §8](../design/00-research-v1.md)). Trafność wymaga, żeby każde znalezisko udowodniło się, zanim trafi do weryfikatora: cytat musi istnieć w kodzie, a blokujące musi wskazać wyzwalacz, ścieżkę od realnego callera i dowód.

## Decyzja
- **Dokument** `FindingSet` (JSON, ADR-0016), jeden plik na soczewkę i shard (`findings/<lens>-<shard>.json`), ze znaleziskami `Finding`:
  - `id` (np. `LOGIC-007`), `lens` (`logic|contracts|conventions|tests|security|equivalence`), `severity` (`blocking|major|minor|nit`), `confidence`, `ruleId`;
  - `location` (plik, linia, symbol), `quote`, `claim`, `trigger`, `expected`, `actual`, `reachability`;
  - `evidence` (`test|trace|rule|doc`), `fixHint`;
  - `verification` (`confirmed|refuted|unproven`, kto i dowód), `alsoFrom` (soczewki po scaleniu).

  W JSON używamy camelCase, tak jak w innych dokumentach MetatorAI.
- **Polityka (`policyProblems`):** `blocking` wymaga `trigger`, `reachability` i `evidence`; obalone (`refuted`) nie może blokować; potwierdzone `blocking` wymaga dowodu wykonywalnego (`test|trace|rule`, nie `doc`).
- **`metator findings validate <dir> [--fix]`:** schemat (z polem), polityka, a cytat sprawdzany tym samym dopasowaniem co cytaty pamięci (`locateQuote`, ADR-0021). Cytat nieistniejący albo brak pliku daje `invalid` (znalezisko nie trafia do Verify); przesunięty daje `moved`, a `--fix` poprawia linię.
- **`metator findings merge <dir>`:** odrzuca nieważne, a duplikaty łączy w `merged.json`. Ta sama przyczyna to ten sam plik i symbol (albo linia) oraz ta sama reguła albo podobieństwo słów twierdzenia ≥ 0,5. Wygrywa wyższa severity i pewność, a pozostałe soczewki trafiają do `alsoFrom`.

## Konsekwencje
### Pozytywne
- Zmyślony cytat jest odrzucany deterministycznie, zanim zużyje czas weryfikatora i recenzenta.
- Ta sama przyczyna z kilku soczewek jest jednym komentarzem.
### Negatywne
- Dopasowanie przyczyny jest leksykalne; różnie opisane przyczyny w tym samym symbolu mogą zostać połączone albo nie. Judge może to poprawić.
- `findings to-github` (publikacja komentarzy) i `verdict` (Judge) to kolejne kroki F3.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Zaufanie modelowi co do cytatów | to główne źródło fałszywych alarmów |
| Deduplikacja po dokładnym tekście twierdzenia | różne soczewki opisują tę samą przyczynę innymi słowami |

## Implikacje dla kodu
ADR-0031 egzekwują reguły kanonu MT-CODE-002, MT-CODE-001 (`metator rules show <id>`).
