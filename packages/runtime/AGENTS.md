# @metator/runtime

The composition root: the awilix container (`src/bootstrap.ts`, `src/container.ts`), the envelope and the config.

- The only package that names concrete adapters (MT-ARCH-007). A new use case gets its registration in `bootstrap.ts` and its type in `container.ts`.
- Paths come from `DEFAULT_PATHS`, overridden by `metator.config.yml` (`resolvePaths`).
