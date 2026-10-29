# ADR-0072: Złoty zbiór zmian systemowych i score analizy oraz planu

- Status: Proposed
- Data: 2026-10-29

## Kontekst
F7.7 ([design/08 §5, §6 S8](../design/08-system-landscape.md)) wymaga mierzalnej trafności analizy i planu systemowego: kryterium wyjścia pilota to impact ≥ 95% aplikacji i plan bez zmian kolejności. Zmiana w promptach `mt-system-scout`, `mt-system-planner` albo w szkicu narzędzia ma być zmierzona, a nie zgadywana, tak jak złoty zbiór refaktorów (ADR-0066).

## Decyzja
- **`SystemEvalCase` v1** (`docs/metator/evals/system/<id>.yml`):
  - zadanie i pliki repozytorium (mapa, specyfikacje, kod);
  - wejście: kontrakty i to, co zadanie łamie;
  - oczekiwania: aplikacje, do których sięga zmiana (wszystkie i żadnej więcej), zmiana każdego kontraktu, kroki planu oraz pary kolejności `[najpierw, potem]`.
- **Score** to średnia sześciu miar, a przypadek przechodzi przy score 1:
  - recall i precyzja aplikacji;
  - trafność zmian kontraktów;
  - czysty lint planu (ostrzeżenia nie przeszkadzają);
  - recall kroków;
  - zachowanie kolejności, liczone przez kroki pośrednie.

  Podsumowanie podaje średni score i średni impact recall (kryterium pilota).
- **`system eval run [--case] [--host] [--min]`:**
  - każdy przypadek dostaje świeże repozytorium (port `Sandbox`, ADR-0066);
  - bez `--host` analizę i szkic robi samo narzędzie (`system plan new`);
  - z `--host` agenci systemowi na hoście (`system plan propose`), z ich definicjami skopiowanymi do sandboxa;
  - `--min` kończy się `CHECK_FAILED` poniżej progu.
- **Zbiór na start:** trzy przypadki:
  - `rename-refunds`: zmiana łamiąca pod expand-contract z aplikacją spoza zmiany;
  - `versioned-prices`: polityka versioned;
  - `add-credits`: zmiana zgodna.

  Narzędzie samo daje na nich score 1, więc to linia bazowa, której agenci nie mogą pogorszyć.

## Konsekwencje
### Pozytywne
- Każda zmiana szkicu, lintu albo agentów systemowych ma liczbę. Regresja kolejności albo pokrycia konsumentów jest widoczna przed wydaniem.
- e2e:
  - dostarczone przypadki w prawdziwym repozytorium dają score 1;
  - zepsute oczekiwanie obniża score i zatrzymuje `--min`;
  - przebieg z hostem scenariuszowym.
### Negatywne
- Trzy syntetyczne przypadki to nie dane z pilota. Kryterium pilota (≥ 95% na prawdziwych zadaniach) wymaga przypadków z rzeczywistych systemów, dopisywanych w tym samym formacie.
- Przypadki opisują monorepo (aplikacje `path`). Wiele repozytoriów w jednym przypadku wymagałoby sandboxa z kilkoma repozytoriami.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Ocena planu przez LLM | niedeterministyczna; reguły kolejności i pokrycia da się sprawdzić narzędziem |
| Porównanie planu z oczekiwanym planem 1:1 | dobry plan może mieć inne opisy i dodatkowe kroki; liczą się aplikacje, zmiany, kroki i kolejność |
| Ewaluacja tylko z agentami | bez linii bazowej narzędzia nie wiadomo, czy agenci coś dodają, czy psują |
