# ADR-0088: Przy terminalu tylko tekst dla osoby

- Status: Accepted
- Data: 2026-11-18

## Kontekst
ADR-0052 ustalił, że stdout zawsze niesie jedną kopertę JSON, a tekst dla osoby idzie na stderr. Przy terminalu osoba widzi więc oba: czytelny tekst i zaraz pod nim surową linię JSON (`metator run ask --wait`, `system plan status`, `status`). Przechwycenie z trzema repozytoriami pokazało to jako wadę; właściciel produktu: przy terminalu komenda z tekstem dla osoby ma pokazać tylko ten tekst.

## Decyzja
- Gdy stdin, stderr i stdout są terminalem, a komenda ma renderer i się udała, wypisywany jest tylko tekst (na stderr); linii JSON na stdout nie ma. Tak samo pomoc (`help`, `--help`).
- Potok, skrypt, narzędzie agenta (stdout nie jest terminalem) i `--json` dostają kopertę JSON jak dotąd. Kod wyjścia się nie zmienia.
- Błąd przy terminalu pokazuje komunikat i podpowiedź oraz nadal swoją kopertę JSON.
- Renderer, który się wywróci, nigdy nie psuje komendy: wtedy wypisywana jest koperta.

## Konsekwencje
- Kontrakt „stdout zawsze JSON” z ADR-0052 obowiązuje dla każdego wywołania bez terminala na stdout; skrypty i agenci nie widzą zmiany.
- Testy e2e w pseudoterminalu czytają tekst z ekranu; JSON tylko z `--json`.

## Implikacje dla kodu
Decyzję opisuje reguła kanonu MT-CODE-004 (`metator rules show MT-CODE-004`): komenda wypisuje jedną kopertę JSON, a przy terminalu komenda z tekstem dla osoby wypisuje tylko ten tekst. Każdą zmianę widoczną dla osoby przy terminalu sprawdza test e2e na prawdziwym procesie w pseudoterminalu (MT-TEST-001).
