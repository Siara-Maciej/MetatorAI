# @metator/plugin-herdr

`HerdrControl` on the herdr CLI (E2, ADR-0079): `workspace create`, `pane run`, `pane get`, `pane report-metadata`, `workspace close`, one `herdr` process per call, JSON answers.

- Never talk to herdr's socket; the CLI is the contract herdr documents, and the guard refuses the socket to agents.
- A pane herdr reports as not found is `{exists: false}`, not an error; every other failure keeps herdr's error code.
- Pitfall: the JSON shapes come from herdr's docs; the contract test runs on a stand-in (`standInHerdr`), the real-herdr e2e needs `METATOR_E2E_HERDR`.
