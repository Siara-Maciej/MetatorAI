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

Other repositories are read from a local checkout when you work locally, or from a clone pinned to `ref` in CI and review (see [Where a change lands](#where-a-change-lands)).

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

## Where a change lands

In a system of many repositories, each application repository points at the one map:

```yaml
# metator.config.yml in the billing and web repositories
kind: MetatorConfig
schemaVersion: 4
system:
  map: { repo: ../platform, ref: main, path: docs/metator/system.yml }   # a URL works too
```

MetatorAI resolves `ref` to a commit once per command and reads the map, and every specification, from a clone of exactly that commit, cached in `.metator/system/`. A map written as a path (`system.map: { path: ... }`) is a file of this repository. In a map pinned by URL, a relative repository (`repo: ../billing`) is a sibling on the same host (`https://github.com/acme/billing`).

```bash
metator system impact                      # the files changed since HEAD
metator system impact --base main          # since a branch
metator system impact --files openapi.yaml # or the files you name
metator system impact --contracts billing-api   # what a change to a contract reaches, from any repository
```

```json
{"map":"../platform@main:docs/metator/system.yml","self":["billing"],
 "contracts":[{"id":"billing-api","owner":"billing","change":"spec","consumers":[{"app":"web","version":"^2"}]}],
 "applications":[
   {"id":"billing","reasons":["its files changed (openapi.yaml)","provides billing-api"],"owners":["@billing-team"]},
   {"id":"web","reasons":["consumes billing-api@^2 (spec)"],"owners":["@web-team"]}],
 "unmapped":[]}
```

| Field | Meaning |
|---|---|
| `self` | the applications this repository is: `system.self`, else those whose `repo` is this repository (its remote or its path), else, with the map here, its `path` applications |
| `change: spec` | the contract's specification changed |
| `change: implementation` | other files of the provider changed: the contract may behave differently |
| `change: named` | you asked about it with `--contracts` |
| `unmapped` | changed files that belong to no application |

**Where the other applications' code is:**

```bash
metator system sources            # each application: here, in the map's checkout, a local checkout, or none
metator system sources --fetch    # clone what is missing, at its pinned ref
metator system lint --fetch       # check specifications in other repositories too
```

| Source in the map | Found at |
|---|---|
| `{ path: apps/web }` | the repository the map is in |
| `{ repo: ../web }` | that directory, relative to the platform repository |
| `{ repo: ../billing, ref: main }`, `{ repo: github.com/shop/mailer }` | a clone at the pinned commit, with `--fetch` |
| any, with `system.roots.<id>` | your local checkout |

Clones never run code and never change your checkouts. Without `--fetch`, MetatorAI does not touch the network, and `system lint` lists the specifications it could not check.

## Is the change safe for consumers?

In the provider's repository, `contract diff` compares each contract's specification at the merge base with the working tree:

```bash
metator contract diff --base main            # every contract this repository provides
metator contract diff --contracts billing-api
metator contract diff --base main --check    # in CI: fail when the map's policy does not allow a change
```

```json
{"base":"main","failing":["billing-api"],
 "contracts":[{"id":"billing-api","spec":"apps/billing/openapi.yaml","status":"breaking","allowed":false,
   "versions":{"before":"1.4.0","after":"1.4.0"},
   "changes":[{"code":"path.remove","severity":"breaking","location":"paths./refunds","message":"removed path at paths./refunds"}],
   "consumers":[{"app":"web","range":"^1","satisfied":true}],
   "reason":"a breaking change (consumed by web): expand first (the new shape beside the old), migrate the consumers, then remove the old (policy: expand-contract)."}]}
```

| Status | Meaning |
|---|---|
| `unchanged`, `compatible` | nothing a consumer relies on changed (added paths, optional fields) |
| `breaking` | something a consumer may use was removed or narrowed |
| `removed`, `added` | the specification itself is gone or new |
| `unclassified` | a change the differ cannot classify: review it by hand |

Whether a breaking change passes depends on the map:

| Map | A breaking change |
|---|---|
| `compatibility: none` on the contract | passes |
| `policies.breaking: expand-contract` (default) | fails: add the new shape beside the old, migrate consumers, then remove the old one |
| `policies.breaking: versioned` | passes with a new major version in the specification; consumers outside the new range are named |
| `policies.breaking: forbidden` | fails |

Add it to the full gate with `{ metator: contract diff }`. OpenAPI 3.0, 3.1 and Swagger 2 are compared on [api-smart-diff](https://github.com/udamir/api-smart-diff):

| Change | Breaking |
|---|---|
| an operation removed, a new required parameter, a parameter made required or removed | yes |
| a response field no longer required, also through a `$ref` | yes |
| a request type that narrows (string → integer), a response type that widens (integer → string) | yes |
| a new operation, a new optional parameter, a request type that widens (integer → number) | no |

Only the API surface counts (`paths`, `webhooks`, `security`, `servers`); a schema in `components` counts where an operation uses it.

## Plan a change across the system

A task that changes a contract others consume becomes a **system plan**: one step per application, in that application's repository, in an order that never breaks a consumer.

```bash
metator system analyze Rename refunds --breaking billing-api   # what the task touches, saved for the plan
metator system plan new Rename refunds                          # a draft by the map's policies
metator system plan propose Rename refunds --host claude        # or let mt-system-scout and mt-system-planner refine it
metator system plan lint rename-refunds
metator system plan approve rename-refunds                      # you, never an agent
```

Under `expand-contract` the draft is:

| Wave | Step | In repository of | What it does |
|---|---|---|---|
| 1 | `billing-expand` | billing | add the new shape of `billing-api` beside the old one |
| 2 | `web-migrate`, `mail-migrate` | web, mail | move each consumer to the new shape |
| 3 | `billing-contract` | billing | remove the old shape |

Under `versioned` it is `bump` (a new major version) and then a `migrate` step for each consumer.

**What lint checks**, so that you review the plan's substance, not its bookkeeping. Consumers come from the map, not from the analysis, and a strategy makes its contract breaking whatever the analysis says; only the provider expands, bumps or contracts its contract.

| Check | Error when |
|---|---|
| Coverage | a consumer of a breaking change has no `migrate` step |
| Order | a consumer migrates before the provider expands, the old shape goes before every consumer migrated, or a consumer runs before its provider (`providers-first`) |
| Strategy | a breaking change has no strategy, a strategy other than the map's policy, or the map forbids breaking changes |
| Map | a step names an application or contract the map does not have, or steps depend on each other in a cycle |
| Analysis | the plan has no analysis: nothing says what breaks |
| Approval | anything a child run is told changed after you approved it: a step, its summary, deploy flag or rollback, the task |

**The gate respects the plan.** Once you approve it, `contract diff --check` lets the breaking change through in the provider's repository, but only for the step that breaks it, and only after the steps before it are done:

```json
{"id":"billing-api","status":"breaking","allowed":true,
 "reason":"planned in system plan rename-refunds (step billing-contract, approved by ana); a breaking change (consumed by web, mail): …"}
```

A package that is an application of the map gets a `System application` line in its [module card](../how-to/knowledge.md), with the contracts it provides and their consumers.

## Carry it out: linked runs

An approved plan runs as a **system run** ([W13 `mt-system-change`](../workflows/system.md)) with a **child run** in each application's repository. The agent never edits several repositories in one session: each step runs where its code is, with that repository's gates and approvals.

```bash
metator system plan run rename-refunds        # the steps that can start, each a child run (W1) in its repository
metator system status rename-refunds          # the child runs read back; the plan is done when every step is
```

Set `system.roots` for the repositories you have checked out. A step whose application has only a clone cannot start.

## Measure it

A change to the planner, its prompts or the system agents is measured on a golden set of system changes in `docs/metator/evals/system/`:

```bash
metator system eval list
metator system eval run                     # the tool alone: the baseline
metator system eval run --host claude       # with mt-system-scout and mt-system-planner
metator system eval run --min 0.95          # in CI: fail below the score
```

Each case is a small repository (the map, specifications, code), a task and what a good result has:

```yaml
kind: SystemEvalCase
schemaVersion: 1
id: rename-refunds
task: Rename refunds to credit notes
input: { breaking: [billing-api] }
files: { docs/metator/system.yml: "…", apps/billing/openapi.yaml: "…" }
expect:
  applications: [billing, web, mail]          # all the change reaches, and no other
  contracts: { billing-api: breaking }
  steps: [billing-expand, web-migrate, mail-migrate, billing-contract]
  order: [[billing-expand, web-migrate], [web-migrate, billing-contract]]
```

| Score | Measures |
|---|---|
| impact recall, precision | the applications the analysis found against the expected ones |
| contracts | each contract's change right (breaking, compatible) |
| lint clean | `system plan lint` has no error |
| steps | the expected steps are in the plan |
| order | the plan keeps every expected order pair, also through other steps |

## Roadmap of the multi-repo phase (F7)

| Step | What it adds | Status |
|---|---|---|
| F7.1 System map | `SystemMap`, `system lint`, `system show`, deploy waves | ✅ available |
| F7.2 Discovery | detect monorepo or separate repositories, applications and OpenAPI specs; propose the map with evidence (`system discover`) | ✅ available |
| F7.3 Impact | read other repositories (checkout or pinned clone); `system impact`: changed files → contracts → consumers → owners | ✅ available |
| F7.4 Compatibility | `contract diff` for OpenAPI (breaking or not) and a contract gate | ✅ available |
| F7.5 System plan | a plan per application, in deploy order, with a strategy for breaking changes; `mt-system-scout`, `mt-system-planner` | ✅ available |
| F7.6 Linked runs | one system run with child runs in each repository, a combined status | ✅ available |
| F7.7 Evals | a golden set of system changes, impact and plan scores | ✅ available |

Contract kinds come from plugins. The MVP supports **OpenAPI**; AsyncAPI, GraphQL, gRPC, npm packages and database schemas follow.
