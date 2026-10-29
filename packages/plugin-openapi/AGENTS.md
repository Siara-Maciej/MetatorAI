# @metator/plugin-openapi

The `openapi` contract kind (F7, design/08): `ContractDetector` finds OpenAPI 3 and Swagger 2 specifications for `system discover`.

- A specification is a YAML or JSON file whose top level has `openapi: 3.x` or `swagger: "2.0"`; anything else is not a contract.
- Pitfall: parse failures are not errors; a broken file is simply not a specification.
