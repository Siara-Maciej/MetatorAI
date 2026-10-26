# @metator/core

The inside of the product: domain model, ports and use cases. It does no I/O of its own.

- `src/domain`: pure TypeScript. No I/O, no `node:*`, no `bun`, no imports from ports or application.
- `src/ports`: interfaces only (at most five members each, MT-ARCH-008); they may import the domain.
- `src/application`: use cases. They take ports through the constructor and return `Result` (MT-ARCH-006).
- Third-party imports only from the approved pure libraries (`mt-arch-core-approved-deps`); wrap a library thinly so its errors come back as `MetatorError`.
- Documents: define them with `defineDocument(kind, { latest, upgrade?, history? })` [[cite: packages/core/src/domain/versioned.ts:52 | "export function defineDocument<S extends z.ZodType>("]]; write only through `Document.stamp(body)`, read only through `Document.parse(raw, source)`. An older version needs `docs/metator/schemas/<Kind>.v<N>.example.json`.
- `schemaVersion` is the file format; a content version is a separate field (a workflow's `revision`).
- `e2e/helpers/versioned.ts` (`findUnversioned`) fails CI for any unversioned file under `.metator/` or `.github/metator/`.
