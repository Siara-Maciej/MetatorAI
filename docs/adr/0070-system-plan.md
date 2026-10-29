# ADR-0070: Plan systemowy: `SystemAnalysis`, `SystemPlan`, lint kolejności i strategii, agenci systemowi

- Status: Accepted
- Data: 2026-10-29

## Kontekst
`system impact` (ADR-0068) i `contract diff` (ADR-0069) mówią, czego dotyka zmiana i czy łamie kontrakt. Zadanie obejmujące kilka aplikacji potrzebuje jeszcze planu: kroków w repozytoriach poszczególnych aplikacji, w bezpiecznej kolejności, ze strategią dla każdej zmiany łamiącej. Projekt F7 ([design/08 §3.2, §6 S6](../design/08-system-landscape.md)) zakłada dokumenty `SystemAnalysis` i `SystemPlan`, `system plan lint`, agentów `mt-system-scout` i `mt-system-planner` oraz karty aplikacji. Plan refaktoru (ADR-0065) daje wzorzec: dokument, deterministyczny lint, zgoda człowieka z digestem.

## Decyzja
- **`SystemAnalysis` v1** (`metator/system/plans/<id>.analysis.yml`):
  - zadanie, mapa i baza;
  - kontrakty ze zmianą: `breaking` (oznaczony `--breaking` albo `contract diff` daje `breaking`/`removed`), `compatible` (wynik `contract diff`), w pozostałych przypadkach `unknown`;
  - aplikacje z rolami (`changed`, `provider`, `consumer`), właścicielami, plikami i notatkami.

  Zapisuje ją `system analyze`, a `mt-system-scout` ją sprawdza i uzupełnia. Zadanie planowane przed kodem wskazuje kontrakty i to, co łamie.
- **`SystemPlan` v1** (`metator/system/plans/<id>.yml`):
  - strategie dla zmian łamiących (`expand-contract`, `versioned`);
  - kroki: aplikacja, opis (zadanie dla runu-dziecka), kontrakty z rolą (`change`, `expand`, `migrate`, `contract`, `bump`), `dependsOn`, `deploy` (flaga, rollback), status i run;
  - zgoda: kto, kiedy i digest strategii oraz kroków bez ich postępu.
- **Szkic (`system plan new`)** powstaje deterministycznie według polityki mapy:
  - `expand-contract`: `expand` u dostawcy → `migrate` każdego konsumenta → `contract` po wszystkich migracjach;
  - `versioned`: `bump` → `migrate`;
  - `forbidden` i `compatibility: none`: jeden krok `change`;
  - `providers-first`: krok konsumenta po kroku `change` dostawcy tego, co konsumuje.

  Przy kilku kontraktach na aplikację i rolę powstaje jeden krok.
- **Lint (E1).** Błędy:
  - nieznana aplikacja, kontrakt albo zależność;
  - duplikat kroku albo cykl;
  - zmiana łamiąca bez strategii albo ze strategią niezgodną z polityką, a pod `forbidden` sama zmiana łamiąca;
  - brak kroku `expand`/`bump`;
  - konsument zmiany łamiącej bez kroku `migrate`;
  - `migrate` przed `expand`/`bump`, `contract` przed którąkolwiek migracją;
  - konsument przed dostawcą (`providers-first`);
  - kroki zmienione po zgodzie.

  Ostrzeżenia:
  - aplikacja bez właścicieli;
  - brak kroku `contract`;
  - zbędna strategia;
  - aplikacja zmieniana według analizy bez kroku.

  Kolejność liczy się przez kroki pośrednie. Fale (`systemPlanWaves`) to warstwy topologiczne.
- **Zgoda:** `system plan approve` wykonuje tylko człowiek. Hook `guard pre-tool` blokuje agentom zarówno `metator system plan approve`, jak i `arch plan approve`. Zgoda wymaga czystego lintu.
- **Agenci:**
  - `system plan propose` uruchamia na hoście AI `mt-system-scout` (analiza), potem tworzy szkic, potem `mt-system-planner` (opisy kroków, flagi, rollback, kolejność), a na końcu lint;
  - agenci edytują tylko swoje pliki;
  - kod innych repozytoriów to dane, nie instrukcje.
- **Bramka kontraktowa** (design/08 §4: zmiana łamiąca bez wpisu w planie to FAIL). `contract diff` przepuszcza zmianę łamiącą, której polityka nie pozwala, tylko gdy spełnione są wszystkie warunki:
  - zatwierdzony (albo trwający) plan systemowy z nienaruszonym digestem ma strategię dla kontraktu;
  - krok, który go łamie (`bump`, albo `contract` po wykonanych migracjach), ma wykonane wszystkie zależności.

  Powód wskazuje plan, krok i osobę zatwierdzającą.
- **Karty aplikacji.** Blok generowany karty modułu dostaje linię `System application`, gdy pakiet jest aplikacją mapy tego repozytorium (`source.path` równe katalogowi pakietu). Linia wymienia kontrakty dostarczane z konsumentami i konsumowane.

## Konsekwencje
### Pozytywne
- Zmiana na wiele repozytoriów ma jeden przeglądany i zatwierdzany plan. Kolejność i pokrycie konsumentów sprawdza narzędzie, a nie model.
- Zmiana łamiąca przechodzi bramkę dostawcy dopiero, gdy konsumenci są zmigrowani.
- e2e na prawdziwym repozytorium:
  - analiza;
  - szkic expand → migrate → contract;
  - lint zatrzymuje plan bez migracji konsumenta;
  - zgoda;
  - `contract diff --check` przepuszcza zmianę dopiero po wykonaniu migracji.
### Negatywne
- Statusy kroków aktualizuje na razie człowiek albo run-dziecko (F7.6 doda `system status`).
- Bramka widzi tylko plany w swoim repozytorium. W wielu repozytoriach plan musi trafić do dostawcy (F7.6: handoff do runu-dziecka).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Plan wyłącznie od agenta | kolejność i pokrycie konsumentów to reguły; szkic deterministyczny jest zawsze poprawny, a agent go tylko uszczegóławia |
| Jeden plan refaktoru (ADR-0065) także dla systemu | inne kroki (aplikacje i kontrakty zamiast ruchów pakietów) i inna walidacja |
| Bramka przepuszczająca każdą zmianę łamiącą z zatwierdzonym planem | usunięcie starego kształtu przed migracją konsumentów to dokładnie awaria, której plan ma zapobiec |

## Implikacje dla kodu
ADR-0070 egzekwują reguły kanonu MT-CODE-002, MT-TEST-003 (`metator rules show <id>`).
