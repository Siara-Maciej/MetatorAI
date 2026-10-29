# @metator/plugin-openapi

The `openapi` contract kind (F7, design/08): `ContractDetector` finds OpenAPI 3 and Swagger 2 specifications for `system discover`; `ContractDiffer` compares two versions of one for `contract diff` (on `openapi-diff`, ADR-0069).

- A specification is a YAML or JSON file whose top level has `openapi: 3.x` or `swagger: "2.0"`; anything else is not a contract.
- Pitfall: parse failures are not errors; a broken file is simply not a specification.
- The differ passes specifications as text (never a URL), so `openapi-diff` fetches nothing; its exceptions become `PARSE_FAILED` values. It does not classify parameter changes or OpenAPI 3.1.
- `ContractDiffer` adapters pass `contractDifferContract` from `@metator/testing`.
