# @metator/plugin-openapi

The `openapi` contract kind (F7, design/08): `ContractDetector` finds OpenAPI 3 and Swagger 2 specifications for `system discover`; `ContractDiffer` compares two versions of one for `contract diff` (on `api-smart-diff`, Swagger 2 through `swagger2openapi`; ADR-0073).

- A specification is a YAML or JSON file whose top level has `openapi: 3.x` or `swagger: "2.0"`; anything else is not a contract.
- Pitfall: parse failures are not errors; a broken file is simply not a specification.
- The differ passes parsed documents (never a URL), so nothing is fetched; anything that is not OpenAPI 3.x or Swagger 2 is `PARSE_FAILED`, never a throw.
- Only the API surface counts (`paths`, `webhooks`, `security`, `servers`): `components` reach it through `$ref`s. A changed `type` in a request or response is reclassified (`typeChange`): api-smart-diff calls every type change non-breaking.
- `ContractDiffer` adapters pass `contractDifferContract` from `@metator/testing`.
