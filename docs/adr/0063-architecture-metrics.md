# ADR-0063: Metryki i granice pakietów, historia zmian, raport HTML

- Status: Proposed
- Data: 2026-10-29

## Kontekst
Fakty i polityka (ADR-0061, ADR-0062) mówią, co jest złamane. Do planu refaktoru trzeba jeszcze wiedzieć, czy podział odpowiedzialności ma sens ([design/11 §5.3](../design/11-package-architecture.md)):
- które pakiety są stabilne, a które tylko przekazują zależności dalej;
- co jest martwe;
- co zmienia się razem;
- które granice przecinają zespoły.

Do rozstrzygnięcia były też dwie rzeczy: knip czy własna analiza martwego kodu, oraz algorytm skupisk plików.

## Decyzja
- **Metryki** (sekcja `metrics` każdego pakietu workspace):
  - `Ca`, `Ce`, niestabilność `I`, abstrakcyjność `A` (udział eksportów typów), odległość `D = |A+I−1|`;
  - głębokość, czyli najdłuższy łańcuch zależności pod pakietem; cykl liczy się jako jeden węzeł;
  - `exportsUsed`, czyli udział eksportów importowanych przez inne pakiety.
  
  `thresholds` polityki (`distance`, `fanOut`, `fanIn`, `files`, `depth`) zamieniają metrykę w ostrzeżenie `threshold`.
- **Użycie eksportów:** lista robocza par (moduł, nazwa) od importów wstecz przez re-eksporty (`export *` bez `default`, przemianowania, `export * as ns`; import przestrzeni nazw sięga wszystkiego). Liczy się w czasie liniowym, a nie per symbol jak `graph callers`.
- **Martwe eksporty: własna analiza, nie knip.**
  - Uzasadnienie (ADR-0010): mamy już indeks importów i symboli z oxc, a knip wniósłby drugi parser, drugi resolver i własny system pluginów i konfiguracji.
  - Testy liczą się jako użycie.
  - Nie są martwe: domyślne eksporty aplikacji, pliki aplikacji, których nic nie importuje (punkty wejścia), i API publikowanego (nie `private`) pakietu.
  - Lista jest obcięta do 200 pozycji.
- **Podział:** spójne składowe grafu plików pakietu bez barreli i plików wejścia, a nie Louvain. Składowe są deterministyczne, wytłumaczalne i nie wymagają nowej zależności. Kandydat do podziału ma co najmniej 2 grupy (≥ 2 pliki, ≥ 1 użytkownik) z różnymi użytkownikami. Użytkownika przypisuje się przez barrel do pliku definicji (`definitionOf`).
- **Scalenie:** prywatna biblioteka z jednym zależnym. Bez tej propozycji zostają:
  - rodzina co najmniej 3 pakietów o tym samym zależnym i tych samych zależnościach (adaptery jednego portu: tak jest w samym MetatorAI);
  - para z różnych warstw albo z różnymi tagami.
- **Huby:** `Ca ≥ 3` i `Ce ≥ 3`. **Martwe pakiety:** prywatne biblioteki bez zależnych.
- **Wspólne zmiany:**
  - port `ChangeHistory` (`GitVcs.commits`) zwraca pliki ostatnich 500 commitów;
  - pary pakietów zmieniane razem co najmniej 3 razy i w co najmniej połowie przypadków, z informacją, czy jeden importuje drugi;
  - commity dotykające więcej niż 10 pakietów są pomijane.
- **Zespoły:** właściciele z `CODEOWNERS` dla `<dir>/package.json`. Raport podaje importy między właścicielami i pakiety bez właściciela. Bez pliku `CODEOWNERS` sekcji nie ma.
- **Aplikacje:** domknięcie zależności każdej aplikacji i zasięg zmiany każdego pakietu.
- **Raport HTML** (`.metator/arch/report.html`):
  - jedna strona bez skryptów i bez sieci, z jasnym i ciemnym motywem;
  - graf pakietów jako SVG w rzędach według głębokości (aplikacje na górze, krawędzie cyklu czerwone, złamane reguły pomarańczowe, najwyżej 6 pakietów w linii);
  - sprawdzony w Chromium na szerokości 1200 i 390 px.

## Konsekwencje
### Pozytywne
- Na samym MetatorAI: wtyczki nie są proponowane do scalenia z runtime, `core` ma `D` 0,58, a para `core`–`runtime` zmienia się razem w 94% commitów.
- e2e na prawdziwym repo z historią git i `CODEOWNERS`: metryki, próg, podział, scalenie, martwe eksporty, wspólne zmiany, zespoły, aplikacje, HTML.
### Negatywne
- Na bazie (`arch check --base`) metryki liczone są na bieżących symbolach. Ostrzeżenie `threshold`, które zależy od zmienionych eksportów, może więc zostać uznane za istniejące już na bazie.
- Symbole importowane po nazwie pakietu, który nie jest zainstalowany, nie mają celu. Bez `install` metryki eksportów i podział są uboższe.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| knip jako adapter | drugi parser i resolver, własna konfiguracja; mamy te same fakty w indeksie |
| Louvain (`graphology-communities-louvain`) | niedeterministyczny bez ziarna, trudny do wytłumaczenia, nowa zależność; spójne składowe wystarczają, bo kandydat i tak trafia do człowieka |
| Abstrakcyjność z klas abstrakcyjnych | w TypeScript typy i interfejsy pełnią rolę abstrakcji |
