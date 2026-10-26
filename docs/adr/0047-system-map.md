# ADR-0047: `SystemMap`: aplikacje, kontrakty i kolejność wdrożeń

- Status: Proposed
- Data: 2026-10-26

## Kontekst
Zadanie w organizacji często dotyka kilku aplikacji, w jednym monorepo albo w osobnych repo. MetatorAI znał dotąd jedno repo i jego pakiety, a nie aplikacje (jednostki wdrożenia) i kontrakty między nimi. Analiza, decyzje i plan F7: [design/08](../design/08-system-landscape.md).

## Decyzja
- **`SystemMap` v1** (`docs/metator/system.yml`, ścieżka w `paths.system`) opisuje system:
  - aplikacje: id, rodzaj, źródło `{ path }` w tym repo albo `{ repo, ref?, path? }` w innym, właściciele, wdrożenie, konsumowane kontrakty `id[@zakres]`;
  - kontrakty: id, rodzaj, aplikacja-właściciel, ścieżka specyfikacji względem źródła właściciela, klasa zgodności;
  - polityki: `deployOrder` (`providers-first` | `none`), `breaking` (`expand-contract` | `versioned` | `forbidden`).

  To, co aplikacja dostarcza, wynika z właściciela kontraktu, więc mapa tego nie powtarza.
- **Rodzaj kontraktu** to id providera z rejestru pluginów, który wstrzykuje runtime (`contractKinds`). MVP rejestruje tylko `openapi`; pozostałe rodzaje są na liście post-MVP (design §9). `system lint` odrzuca rodzaj bez pluginu i podaje listę wspieranych.
- **`system lint`** sprawdza:
  - duplikaty;
  - właściciel kontraktu jest aplikacją;
  - konsumowany kontrakt istnieje (konsumpcja własnego kontraktu to ostrzeżenie);
  - brak cyklu wdrożeń przy `providers-first`;
  - w tym repo: katalog aplikacji i plik specyfikacji istnieją.

  Specyfikacje z innych repo trafiają do `unchecked`, dopóki F7.3 nie da ich źródeł. Brak mapy oznacza brak czego sprawdzać, więc `meta check-all` uruchamia `system lint` w każdym repo.
- **`system show`** zwraca dostawcę i konsumentów każdego kontraktu oraz fale wdrożeń: kolejność topologiczna na graphlib, aplikacje niezależne w jednej fali.

## Konsekwencje
### Pozytywne
- Agent dostaje jednym poleceniem odpowiedź, które aplikacje konsumują kontrakt i kto wdraża pierwszy.
- Nowy rodzaj kontraktu to nowy plugin, bez zmiany schematu.
### Negatywne
- Mapę trzeba utrzymywać; `system discover` (F7.2) i `system lint` w CI ograniczają rozjazd.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Rodzaje kontraktów jako enum w schemacie | każdy nowy rodzaj wymagałby nowej wersji dokumentu |
| Lista `provides` w aplikacji obok właściciela kontraktu | dwa źródła tej samej informacji |
| Katalog Backstage jako jedyne źródło | nie każda organizacja go ma; adapter Backstage jest na liście post-MVP |
