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

## Let MetatorAI propose it

You do not have to write the map from scratch:

```bash
metator system discover            # in a repository (one application or a monorepo), or in a folder of repositories
metator system discover --write    # write the proposal to docs/metator/system.yml when there is no map yet
metator system discover --check    # in CI: fail when the map lacks what the code shows
```

```json
{"topology":"monorepo",
 "proposal":{"system":"shop","applications":[
    {"id":"billing","kind":"service","source":{"path":"apps/billing"},"owners":["@billing-team"],"deploy":{"unit":"billing"},"consumes":[]},
    {"id":"web","kind":"frontend","source":{"path":"apps/web"},"owners":["@web-team"],"consumes":["billing-api"]}],
  "contracts":[{"id":"billing-api","kind":"openapi","owner":"billing","spec":{"path":"openapi.yaml"}}]},
 "evidence":[
    {"subject":"consumes:web→billing-api","reason":"refers to the specification openapi.yaml","file":"apps/web/package.json","confidence":"medium","proposed":true},
    {"subject":"consumes:notify-worker→billing-api","reason":"calls billing.shop.internal, where the specification says it is served","confidence":"low","proposed":false}]}
```

**What it looks at:**

| Finding | From |
|---|---|
| Topology | a folder of repositories (`repos`), a repository with several applications (`monorepo`), or one application (`single`) |
| Applications | workspace packages nothing depends on that run on their own, and packages with a `Dockerfile` (a deploy unit); in a folder, each repository |
| Kind | `service` (an API specification or a server framework), `frontend` (React, Vue, Svelte, …), `worker` or `gateway` (by name), `other` (a command-line tool, anything else) |
| Contracts | OpenAPI 3 and Swagger 2 specifications inside an application (contract kinds are plugins) |
| Consumers | another application's files that refer to the specification (`../billing/openapi.yaml`, medium confidence), or call the host its `servers` name (low confidence: shown, not proposed) |
| Owners | `CODEOWNERS` |

Discovery never overwrites an approved map. Review the proposal like any other change.

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
| F7.2 Discovery | detect monorepo or separate repositories, applications and OpenAPI specs; propose the map with evidence (`system discover`) | ✅ available |
| F7.3 Impact | read other repositories (checkout or pinned clone); `system impact`: changed files → contracts → consumers → owners | next |
| F7.4 Compatibility | `contract diff` for OpenAPI (breaking or not) and a contract gate | planned |
| F7.5 System plan | a plan per application, in deploy order, with a strategy for breaking changes; `mt-system-scout`, `mt-system-planner` | planned |
| F7.6 Linked runs | one system run with child runs in each repository, a combined status | planned |

Contract kinds come from plugins. The MVP supports **OpenAPI**; AsyncAPI, GraphQL, gRPC, npm packages and database schemas follow.
