# @metator/runtime

The composition root: the awilix container (`src/bootstrap.ts`, `src/container.ts`), the envelope and the config.

- The only package that names concrete adapters (MT-ARCH-007). A new use case gets its registration in `bootstrap.ts` and its type in `container.ts` (`test/every-key.test.ts` checks both). A new AI host is one descriptor in `HOSTS`; nothing else in `bootstrap.ts` names a host.
- Paths come from `DEFAULT_PATHS`, overridden by `metator.config.yml` (`resolvePaths`).
