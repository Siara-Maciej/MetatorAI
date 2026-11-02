# Changelog

MetatorAI is pre-alpha and installed from a checkout, so there are no numbered releases yet. This page lists what changed on the default branch, newest first, in terms a user sees. Every file MetatorAI writes carries a `schemaVersion`; a new version of a document is named here when it appears.

## November 2026

- **Documentation reorganised** around the seven concepts: Start, Concepts, Work, Knowledge, Modules, Reference. Old addresses under `/guide/`, `/workflows/`, `/how-to/`, `/agents/`, `/multi-repo/`, `/product/` and `/api/` moved; the README links point at the new ones.
- **Sessions and terminals** (in progress): the host's CLI runs in a terminal MetatorAI owns, with a driver lock, a decision inbox, a terminal grid for groups of sessions and a supervisor. `Question` v2 (decision card), `RunMessage` v1 and `SupervisorPolicy` v1 are the new documents.

## October 2026

- `metator setup`, `agents install|update` with an install lock (ADR-0049).
- Worktrees per run with port blocks (`RunRecord` v3, ADR-0050); `run drive`, `run continue`, questions and answers from the terminal (ADR-0051, ADR-0052).
- Application environments: `env discover|init|up|down|status|logs`, fast start with shared databases and a warm pool (ADR-0053, ADR-0055).
- `metator ui` on Ink, `metator ask` with citations, `metator status`, a folder of repositories (ADR-0056 to ADR-0060).
- Package architecture: `arch analyze|check|simulate|plan|eval` (ADR-0061 to ADR-0066).
- Systems of many applications: system map, `system discover|impact|analyze|plan`, `contract diff`, linked runs (ADR-0047, ADR-0067 to ADR-0073).
- Review with proof: findings, verification, the judge, evals on a golden set (ADR-0031 to ADR-0034).
- The rule canon with E1 engines (ast-grep, Biome, tsc), patterns, module cards, the memory map (ADR-0020 to ADR-0027).

The decisions behind each change are in the repository's `docs/adr/`.
