# ADR-0016: Każdy plik jest wersjonowanym dokumentem

- Status: Accepted
- Data: 2026-10-25

## Kontekst
MetatorAI zapisuje i czyta wiele plików: specyfikacje workflow, stan runu, log audytowy, wskaźnik ostatniego runu, a wkrótce indeks, karty modułów, raporty review i konfigurację. Te pliki przeżywają aktualizacje narzędzia, są commitowane do repo i czytane przez różne wersje CLI, hosty AI i CI. Bez jawnej wersji formatu nie wiadomo, jak plik parsować, a zmiana schematu po cichu psuje stare pliki albo, co gorsza, prowadzi do błędnej interpretacji.

## Decyzja
**Każdy dokument zaczyna się nagłówkiem `kind` + `schemaVersion`**, np.:

```yaml
kind: Workflow
schemaVersion: 1
```

| Format | Gdzie jest nagłówek |
|--------|---------------------|
| JSON | pola na najwyższym poziomie (`{"kind": "RunRecord", "schemaVersion": 1, ...}`) |
| YAML | pola na najwyższym poziomie |
| Markdown | YAML front matter (`---\nkind: RunLog\nschemaVersion: 1\n---`) |

Mechanizm `defineDocument(kind, { latest, upgrade?, history? })` w `core/domain/versioned.ts`:
- **czyta** nagłówek, wybiera schemat zod dla danej wersji i waliduje treść tym schematem,
- **migruje** starsze wersje krok po kroku (`v1 → v2 → … → current`), walidując wynik każdego kroku schematem kolejnej wersji, co łapie błędy migracji,
- **odrzuca** wersje nowsze niż obsługiwane („zaktualizuj metator-ai”), brak nagłówka, zły `kind` i nonsensowne wersje,
- **zapisuje** wyłącznie przez `stamp()`, który dokleja bieżący nagłówek,
- **eksportuje** JSON Schema z nagłówkiem jako stałymi (dla agentów i edytorów).

`schemaVersion` to wersja **formatu pliku**. Wersja **treści** (np. kolejna rewizja workflow) to osobne pole, np. `revision` w specyfikacji workflow.

Bieżące dokumenty:

| kind | Plik | Wersja |
|------|------|--------|
| `Workflow` | `.github/metator/workflows/*.yml` | 1 |
| `RunRecord` | `.metator/runs/<id>/state.json` | 1 |
| `RunLog` | `.metator/runs/<id>/log.md` | 1 |
| `RunPointer` | `.metator/runs/latest.json` | 1 |

Zmiana schematu dokumentu = nowa wersja + funkcja migracji + test migracji. Test e2e (`findUnversioned`) sprawdza, że każdy plik w `.metator/` i `.github/metator/` ma nagłówek.

## Konsekwencje
### Pozytywne
- Wiadomo, jak sparsować każdy plik, także zapisany przez starszą albo nowszą wersję narzędzia.
- Stare pliki działają po aktualizacji dzięki migracjom; nowsze nie są błędnie interpretowane.
- Jeden mechanizm dla wszystkich formatów i rodzajów dokumentów (DRY).

### Negatywne
- Pliki pisane ręcznie (specyfikacje workflow) muszą zawierać dwa dodatkowe pola.
- Każda zmiana formatu wymaga migracji i jej testu (świadomy koszt).

## Alternatywy odrzucone
| Alternatywa | Dlaczego odrzucona |
|-------------|--------------------|
| Wersja tylko w nazwie pliku (`state.v1.json`) | łatwo ją zgubić przy kopiowaniu, nie działa dla plików pisanych przez ludzi |
| `$schema` z URL | wymaga hostowania schematów, nie mówi wprost, którą wersję migrować |
| Wersja tylko dla wybranych plików | dokładnie problem, który ten ADR rozwiązuje |

## Implikacje dla kodu
ADR-0016 egzekwują reguły kanonu MT-CODE-002, MT-CODE-003 (`metator rules show <id>`).
