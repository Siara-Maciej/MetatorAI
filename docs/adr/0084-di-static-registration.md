# ADR-0084: DI: awilix ze statyczną rejestracją w runtime i kontenerem na repozytorium

- Status: Proposed
- Data: 2026-11-12

## Kontekst
[ADR-0011](0011-di-awilix.md) wybrał awilix i opisał trzy mechanizmy, których kod nie ma i nie potrzebuje: `resolvePort()` zamieniające błąd awilix na `MetatorError` z kodem `BINDING_MISSING`, rejestrację implementacji przez same pluginy (`container.register` w pluginie) i `createScope()` na każdy run. Wybór biblioteki pozostaje aktualny; nieaktualny jest opis tego, jak z niej korzystamy. Audyt (runda 1) wskazał tę rozbieżność jako pozycję właściciela.

Stan kodu dzisiaj:
- `packages/runtime/src/container.ts` tworzy kontener awilix w trybie `InjectionMode.PROXY` ze `strict: true`; interfejs `Cradle` typuje każdy port i każdy use case.
- `packages/runtime/src/bootstrap.ts` rejestruje wszystko statycznie w jednej funkcji `bootstrap()`. Pluginy eksportują klasy adapterów i nie znają kontenera (MT-ARCH-005, MT-ARCH-007).
- Kontener powstaje na katalog repozytorium (`containerAt(root)` w CLI; demon trzyma po jednym na repozytorium z folderu). Run nie ma własnego scope: jego stan leży na dysku (`.metator/runs`), a każda komenda jest krótkim procesem.
- Nie ma `resolvePort()` ani kodu `BINDING_MISSING`. Błąd rozwiązywania zależności jest błędem programu i wychodzi w kopercie jako `INTERNAL`.

## Decyzja
Po akceptacji ten ADR zastępuje ADR-0011 (który dostaje wtedy status `Superseded by ADR-0084`).

- **Biblioteka bez zmian:** awilix 13, `InjectionMode.PROXY`, `strict: true`, bez dekoratorów. Wpis w rejestrze zależności wskazuje wtedy na ten ADR.
- **Rejestracja statyczna, w jednym miejscu.** Tylko `packages/runtime/src/bootstrap.ts` zna konkretne adaptery i rejestruje je wraz z use case'ami. Plugin implementuje porty z `@metator/core` i eksportuje klasy; nie importuje kontenera i niczego sam nie rejestruje. Nie ma ładowania pluginów z konfiguracji: wybór z konfiguracji (np. `hosts.targets`) odbywa się wewnątrz `bootstrap()` między adapterami, które runtime już zna.
- **Typ `Cradle` jest kontraktem.** Każdy port i use case ma pole w `Cradle`; use case dostaje zależności przez konstruktor (MT-ARCH-006). Brak rejestracji wychodzi w typach i w testach, które budują kontener, a nie u użytkownika.
- **Jeden kontener na repozytorium, bez scope'ów.** CLI buduje kontener dla katalogu repozytorium (w worktree runu: dla głównego checkoutu, z identyfikatorem runu jako wartością). Demon trzyma kontener na repozytorium. Stan runu należy do `RunRepository` i plików, nie do pamięci procesu, więc `createScope()` na run nie ma czego izolować.
- **Czas życia:** domyślnie obiekt powstaje przy każdym rozwiązaniu; `.singleton()` dostają adaptery, które trzymają stan albo zasób procesu (blokady, runner procesów, cache'e, VCS).
- **Błędy rozwiązywania nie mają własnego kodu.** `AwilixResolutionError` jest błędem programu: koperta zwraca go jako `INTERNAL` (`fromUnknown` w `packages/runtime/src/envelope.ts`). Nie dodajemy `resolvePort()` ani `BINDING_MISSING`, bo przy statycznej rejestracji użytkownik nie może tego błędu ani wywołać, ani naprawić.

## Konsekwencje
### Pozytywne
- Dokument mówi to, co robi kod: jedna funkcja pokazuje cały graf obiektów, a reguły architektury (plugin zna tylko core, runtime zna adaptery) są egzekwowane przez ast-grep.
- Mniej własnego kodu wokół kontenera: żadnej warstwy `resolvePort()`, żadnych scope'ów do sprzątania.

### Negatywne
- `bootstrap.ts` rośnie z każdym use case'em (dziś ponad 200 rejestracji) i jest miejscem konfliktów przy równoległych zmianach.
- Plugin spoza repozytorium nie może się sam dołączyć. Gdy taka potrzeba wróci, wymaga nowego ADR (rejestr pluginów albo rejestracja przez plugin) i modelu bezpieczeństwa z [ADR-0007](0007-security-model.md).
- Literówka w nazwie z `Cradle` wychodzi dopiero przy `resolve`, tak jak w ADR-0011; łagodzi to typ `Cradle` i testy budujące kontener.

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Zostawić ADR-0011 bez zmian | opisuje `resolvePort()`, rejestrację przez pluginy i scope na run, których kod nie ma |
| Dopisać brakujące mechanizmy do kodu | brak potrzeby: nie ma dynamicznych pluginów ani stanu runu w pamięci, który scope miałby izolować |
| Rejestracja przez pluginy (`register(container)`) | plugin musiałby znać kontener, co łamie MT-ARCH-005; graf obiektów rozpadłby się na wiele plików |

## Implikacje dla kodu
Decyzję egzekwują reguły kanonu MT-ARCH-005, MT-ARCH-006, MT-ARCH-007 i MT-CODE-005 (`metator rules show <id>`). Zmian w kodzie nie ma: ADR opisuje stan obecny. Po akceptacji: status ADR-0011, wiersz indeksu i wpis `awilix` w `docs/metator/dependencies.yml` wskazują na ten ADR, a komentarz w `packages/runtime/src/container.ts` cytuje ADR-0084.
