# Systems of many applications

Real tasks rarely stay inside one application. "Customers can combine discounts" touches the web frontend, the gateway, the billing service and the notification worker, often in separate repositories. An agent that sees one repository at a time will miss the consumer, or ship in the wrong order.

MetatorAI adds one level above the repository: **the system map**. It describes:
- the applications (what you deploy);
- the contracts between them (what they promise each other);
- the policies for changing them.

<SystemDiagram />

## Monorepo or many repositories

The same map describes both topologies, and mixed setups too:

| Topology | How an application's source is written |
|---|---|
| Monorepo with several applications | `source: { path: apps/web }` |
| Separate repositories | `source: { repo: github.com/shop/mailer, ref: v1.4.0 }` |
| Mixed | both kinds in one map |

Other repositories are read from a local checkout when you work locally, or from a clone pinned to `ref` in CI and review (F7.3).

## Describe the system

```yaml
# docs/metator/system.yml (in a platform repository; applications pin it)
kind: SystemMap
schemaVersion: 1
system: shop
applications:
  - id: orders
    source: { repo: github.com/shop/orders }
    owners: ["@shop/orders"]
  - id: billing
    source: { path: services/billing }
  - id: gateway
    kind: gateway
    source: { path: apps/gateway }
    consumes: [orders-api@^1, billing-api]
  - id: mailer
    kind: worker
    source: { repo: github.com/shop/mailer, ref: v1.4.0 }
    consumes: [orders-api]
  - id: web
    kind: frontend
    source: { repo: github.com/shop/web }
    consumes: [gateway-api]
contracts:
  - id: orders-api
    kind: openapi
    owner: orders
    spec: { path: openapi.yaml }
  - id: billing-api
    kind: openapi
    owner: billing
    spec: { path: openapi.yaml }
  - id: gateway-api
    kind: openapi
    owner: gateway
    spec: { path: openapi/public.yaml }
policies:
  deployOrder: providers-first     # a provider deploys before its consumers
  breaking: expand-contract        # breaking changes: expand, migrate consumers, then contract
```

| Concept | Meaning | Why it matters |
|---|---|---|
| Application | a unit you deploy | the agent plans per application, in that application's repository |
| Contract | an interface one application provides and others consume | a change to it has consumers, even in repositories the agent cannot see |
| `consumes: orders-api@^1` | the contract and the version range a consumer expects | a breaking change outside the range needs a migration plan |
| `deployOrder: providers-first` | deploy order from the contract graph | the plan ships in waves, providers first |

## Check and read it

```bash
metator system lint      # owners, consumed contracts, contract kinds, deploy cycles, local specs
metator system show      # each contract's provider and consumers, and the deploy waves
metator system schema    # the JSON Schema of the map
```

```json
{"contracts":[{"contract":"orders-api","kind":"openapi","owner":"orders","consumers":["gateway","mailer"]}, …],
 "deployWaves":[["billing","orders"],["gateway","mailer"],["web"]]}
```

`system lint` runs inside `metator meta check-all`, so a map that drifts from the code fails CI.

## Roadmap of the multi-repo phase (F7)

| Step | What it adds | Status |
|---|---|---|
| F7.1 System map | `SystemMap`, `system lint`, `system show`, deploy waves | ✅ available |
| F7.2 Discovery | detect monorepo or separate repositories, applications and OpenAPI specs; propose the map with evidence | next |
| F7.3 Impact | read other repositories (checkout or pinned clone); `system impact`: changed files → contracts → consumers → owners | planned |
| F7.4 Compatibility | `contract diff` for OpenAPI (breaking or not) and a contract gate | planned |
| F7.5 System plan | a plan per application, in deploy order, with a strategy for breaking changes; `mt-system-scout`, `mt-system-planner` | planned |
| F7.6 Linked runs | one system run with child runs in each repository, a combined status | planned |

Contract kinds come from plugins. The MVP supports **OpenAPI**; AsyncAPI, GraphQL, gRPC, npm packages and database schemas follow.
