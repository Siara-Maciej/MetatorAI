# ADR-0081: MetatorAI jako serwer MCP (tylko komendy czytające)

- Status: Proposed
- Data: 2026-11-09

## Kontekst
Agenci w IDE, czatach i innych narzędziach rozmawiają z narzędziami przez Model Context Protocol. MetatorAI odpowiada na pytania o repozytorium (graf importów, symbole, reguły, karty, stan runów) komendami `metator`, których wynik jest jedną linią JSON. Roadmapa (P8) przewiduje serwer MCP, żeby te same odpowiedzi były dostępne bez terminala.

## Decyzja
- **`metator mcp`** uruchamia serwer MCP na stdio (`@modelcontextprotocol/sdk`, ADR-0010: gotowa biblioteka zamiast własnego JSON-RPC). Każda komenda czytająca z drzewa komend to jedno narzędzie `metator_<słowa>` z argumentem `args` (opcje i argumenty jak w linii poleceń); wywołanie wykonuje komendę w tym samym procesie (te same przypadki użycia co terminal) i zwraca kopertę JSON jako tekst, z `isError`, gdy koperta mówi o błędzie.
- **Tylko czytanie.** Lista narzędzi to jawna allowlista prefiksów komend (`packages/cli/src/mcp.ts`). Nic, co pisze do repozytorium, uruchamia skrypty projektu, steruje runem, odpowiada na pytania osoby albo rozmawia z hostem AI, nie jest narzędziem: te działania zostają przy osobie i hookach runu (ADR-0038, ADR-0077). Narzędzia niosą adnotacje `readOnlyHint`.
- Stdout należy do protokołu: komenda nie drukuje własnej koperty, dopóki klient nie zamknie połączenia; `--list` wypisuje narzędzia bez serwowania.

## Konsekwencje
- Pozytywne: jedna powierzchnia odpowiedzi dla terminala, demona i MCP; dodanie komendy czytającej do allowlisty to jedna linia; test jednostkowy pilnuje, że każde narzędzie istnieje w drzewie i że komendy piszące nie są narzędziami.
- Negatywne: argumenty są przekazywane jako lista łańcuchów, nie jako typowany schemat per narzędzie; host MCP musi znać `metator <komenda> --help`. Typowane schematy dla najczęstszych narzędzi mogą dojść później.

## Implikacje dla kodu
- `packages/cli/src/mcp.ts` (narzędzia, allowlista), `packages/cli/src/commands/mcp.ts` (serwer na stdio), e2e klientem SDK przez stdio.
- Zależność `@modelcontextprotocol/sdk` w rejestrze (MT-CODE-005).
