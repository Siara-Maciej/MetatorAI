# Systems of many applications

**Goal:** when a task touches several applications (a frontend, a gateway, services, in one monorepo or in separate repositories), the agent knows:

- which applications it touches;
- through which contract;
- in which order to deploy;
- who owns each part.

::: info Status
Available now: the system map, `system lint` and `system show`. Coming next: automatic discovery, `system impact`, OpenAPI breaking-change checks and linked runs across repositories. The MVP supports OpenAPI contracts; other kinds come later through plugins.
:::

## Describe the system

```yaml
# docs/metator/system.yml
kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - id: web
    kind: frontend
    source: { path: apps/web }                  # a directory in this repository
    consumes: [orders-api@^1]                   # contract and the version range it expects
  - id: orders
    source: { path: services/orders }
    owners: ["@shop/orders"]
  - id: mailer
    source: { repo: github.com/shop/mailer, ref: v1.4.0 }   # another repository, pinned
    consumes: [orders-api]
contracts:
  - id: orders-api
    kind: openapi
    owner: orders                               # the application that provides it
    spec: { path: openapi.yaml }                # relative to the owner's source
policies:
  deployOrder: providers-first                  # a provider deploys before its consumers
  breaking: expand-contract                     # breaking changes: expand, migrate, then contract
```

**Why an application is not a package:** an application is what you deploy. Packages stay in module cards; the system map is one level up.

## Check it

```bash
metator system lint
```

It reports:

- duplicates;
- an owner that is not an application;
- a consumed contract that does not exist;
- a contract kind without a plugin (for example `asyncapi` today);
- a deploy cycle;
- a missing application directory or specification file in this repository.

Specifications in other repositories are listed as `unchecked` until their sources are read.

## Read it

```bash
metator system show
```

```json
{"contracts":[{"contract":"orders-api","kind":"openapi","owner":"orders","consumers":["mailer","web"]}],
 "deployWaves":[["orders"],["mailer","web"]]}
```

**Why deploy waves:** if `orders-api` changes, `orders` ships first; `mailer` and `web` can follow together. The plan for a change across applications follows these waves.
