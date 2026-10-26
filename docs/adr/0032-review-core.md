# ADR-0032: Subflow review: plan shardów, werdykt i komentarze

- Status: Proposed
- Data: 2026-10-26

## Kontekst
Subflow `mt-review-core` ([workflows §3.1](../design/02-workflows.md)) to FIND → VALID → DEDUP → VERIFY → JUDGE. ADR-0031 pokrył walidację i scalanie znalezisk. Brakuje deterministycznych kroków na początku (podział zmiany) i na końcu (decyzja, komentarze) oraz agentów, którzy je wywołują.

## Decyzja
- **`metator review plan [--base|--files] [--lenses] [--max-files 15] [--out]`:** zmienione pliki (bez usuniętych i ignorowanych) dzielone na shardy per pakiet workspace, z porcjami po `--max-files`. Każdy shard dostaje kartę modułu (jeśli istnieje) i ID reguł kanonu, które go dotyczą. `tasks` = shardy × soczewki. Wynik to wersjonowany `ReviewPlan`.
- **`metator findings verdict <dir> [--verified-correct …]`** (deterministyczna część Judge, `judge()`):
  - blokuje tylko potwierdzony (`confirmed`) blocker;
  - niezweryfikowany blocker oznacza `NEEDS_VERIFICATION`;
  - `refuted` znika, a `unproven` i reszta trafiają do `consider`.

  Wynik to wersjonowany `Verdict` w `<run>/verdict.json`.
- **`metator findings to-github <verdict> [--format natural|labeled]`:** komentarze inline tylko dla potwierdzonych blockerów, reszta w podsumowaniu (żeby nie zalewać PR-a). Odmawia dla werdyktu bez decyzji. Publikację robi agent przez MCP code hosta, po zatwierdzeniu przez człowieka.
- **Agenci kanoniczni** (ADR-0030): `mt-pr-review` (koordynator), `mt-review-{logic,contracts,conventions,tests,security}`, `mt-verifier` (próbuje obalić jedno znalezisko w czystym kontekście, z pierwszeństwem dowodu wykonywalnego) i `mt-judge` (kalibracja, „verified correct”).

## Konsekwencje
### Pozytywne
- Każdy krok poza samym szukaniem i weryfikacją jest deterministyczny i testowany; agenci wołają komendy, nie interpretują reguł decyzji.
### Negatywne
- Złoty zbiór i `eval run|score|compare` (miara precision/recall) to następny krok F3; bez nich trafności nie da się jeszcze zmierzyć.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Decyzja wyłącznie przez agenta Judge | niedeterministyczna; łatwo „przepuścić” niezweryfikowany blocker |
| Komentarz inline dla każdego znaleziska | zalewa PR, obniża zaufanie do review |
