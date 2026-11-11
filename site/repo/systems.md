# Systems of applications

When a change in one application can break another, MetatorAI needs to know how the applications relate. A system map lists the applications, the API contracts between them and the policy for changing a contract. With it, MetatorAI can tell you which applications a change reaches, whether it breaks a consumer, and in what order to ship. You do not need this when your changes stay inside one application.

The idea in a small picture: a provider owns a contract, consumers depend on it, and a change ships to the provider first.

```text
orders ──provides──▶ orders-api ◀──consumes── gateway, mailer
deploy order:  orders  →  gateway, mailer
```

## Write the map

The map is one file. The same format covers a monorepo, separate repositories and a mix:

```yaml
# docs/metator/system.yml
kind: SystemMap
schemaVersion: 2
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
contracts:
  - id: orders-api
    kind: openapi
    owner: orders
    spec: { path: openapi.yaml }
  - id: billing-api
    kind: openapi
    owner: billing
    spec: { path: openapi.yaml }
policies:
  deployOrder: providers-first
  breaking: expand-contract
```

| Key | Meaning |
|---|---|
| `applications[].source` | `{ path }` for an application in the map's repository, `{ repo, ref }` for one in another repository |
| `applications[].kind` | `service` (default), `frontend`, `worker`, `gateway`, `library` or `other` |
| `applications[].consumes` | contract ids, optionally with the version range the consumer expects (`orders-api@^1`) |
| `contracts[].owner` | the application that provides the contract |
| `contracts[].spec` | `{ path }` to the specification file in the owner's source, or `{ served: /docs-json }` when the application serves the document at runtime |
| `contracts[].compatibility` | `backward` (default), `forward`, `full` or `none` |
| `policies.deployOrder` | `providers-first` (default) or `none` |
| `policies.breaking` | `expand-contract` (default), `versioned` or `forbidden` |

Contracts are OpenAPI specifications (OpenAPI 3.0 and 3.1, Swagger 2).

## Let MetatorAI propose the map

```bash
metator system discover            # print a proposal with its evidence
metator system discover --write    # write it to the map file when there is none
metator system discover --check    # fail when the map lacks what the code shows
```

Run it in a repository or in a [folder of repositories](./repositories.md). Discovery proposes applications (packages with a `Dockerfile` or that run on their own, or each repository of a folder), contracts (OpenAPI specifications inside an application), consumers (applications whose files refer to a specification or call its routes) and owners (from CODEOWNERS). Each proposal comes with evidence and a confidence. Low-confidence findings are shown and not proposed.

Discovery never reads a real env file such as `.env`, only templates such as `.env.example`. It never overwrites a map. Review the proposal like any other change.

## Check and read the map

```bash
metator system lint      # owners, consumed contracts, contract kinds, deploy cycles, specifications
metator system show      # each contract's provider and consumers, and the deploy waves
metator system schema    # the JSON Schema of the map
```

`system lint` is part of `metator meta check-all`, so a broken map fails CI.

## Point each repository at the map

With several repositories, keep the map in one of them and point the others at it:

```yaml
# metator.config.yml in the billing and web repositories
system:
  map: { repo: ../platform, ref: main, path: docs/metator/system.yml }
  roots:
    web: ../web            # your local checkout of an application
```

`repo` is a path or a URL. MetatorAI resolves `ref` to a commit and reads the map and the specifications from a clone of that commit, cached in `.metator/system/`. `system.roots` tells it where your own checkouts of other applications are. `system.self` names the applications this repository is, when MetatorAI cannot tell from the map.

```bash
metator system sources            # where each application's code is on this machine
metator system sources --fetch    # clone what has no local checkout, at its pinned ref
metator system lint --fetch       # also check specifications in other repositories
```

Without `--fetch`, MetatorAI does not touch the network. Clones never run code and never change your checkouts.

## See where a change lands

```bash
metator system impact                           # the files changed since HEAD
metator system impact --base main               # since the merge base with main
metator system impact --files openapi.yaml      # the files you name
metator system impact --contracts billing-api   # everything a change to this contract reaches
```

The answer lists the contracts the change touches, with their consumers, and every application it reaches with the reasons and the owners. A contract's `change` is `spec` when its specification changed, `implementation` when other files of its provider changed, and `named` when you asked with `--contracts`. Changed files that belong to no application and that no application imports are listed under `unmapped`.

## Check a contract change

In the provider's repository, `contract diff` compares each contract's specification at the merge base with your working tree:

```bash
metator contract diff --base main
metator contract diff --contracts billing-api
metator contract diff --base main --check    # fail when the map's policy does not allow a change
```

| Status | Meaning |
|---|---|
| `unchanged`, `compatible` | nothing a consumer relies on changed (for example an added path or an optional field) |
| `breaking` | something a consumer may use was removed or narrowed |
| `removed`, `added` | the specification itself is gone or new |
| `unclassified` | the differ cannot classify the change: review it by hand |

A removed operation, a new required parameter and a narrowed request type are breaking. A new operation and a new optional parameter are compatible.

Whether a breaking change passes `--check` depends on the map:

| Map | A breaking change |
|---|---|
| `compatibility: none` on the contract | passes |
| `policies.breaking: expand-contract` | fails, unless an approved system plan covers it (below) |
| `policies.breaking: versioned` | passes with a new major version in the specification |
| `policies.breaking: forbidden` | fails |

Add it to the full gate with `{ metator: contract diff }` (see [Gates and CI](./gates-ci.md)). A contract with a `served` specification has no file to compare and is listed under `notCompared`.

## Plan a breaking change

A breaking change to a contract with consumers needs steps in several applications, in an order that never breaks a consumer. A system plan holds those steps.

```bash
metator system analyze Rename refunds --breaking billing-api   # what the task touches
metator system plan new Rename refunds                          # a draft from the map's policies
metator system plan lint rename-refunds
metator system plan approve rename-refunds                      # you, never an agent
```

Instead of `plan new`, `metator system plan propose Rename refunds --host claude` lets the `mt-system-scout` and `mt-system-planner` agents check the analysis against the code and refine the plan. The result is still a draft for you to approve.

Under `expand-contract` the draft has three waves:

| Wave | Step | Repository | What it does |
|---|---|---|---|
| 1 | `billing-expand` | billing | add the new shape of `billing-api` beside the old one |
| 2 | `web-migrate`, `mail-migrate` | web, mail | move each consumer to the new shape |
| 3 | `billing-contract` | billing | remove the old shape |

Under `versioned` the draft is a `bump` step (a new major version) and a `migrate` step for each consumer.

`system plan lint` reports an error when:

- a consumer of a breaking change has no `migrate` step;
- a consumer migrates before the provider expands, or the old shape is removed before every consumer migrated;
- a breaking change has no strategy, or one the map's policy does not allow;
- a step names an application or contract the map does not have;
- a step changed after you approved the plan.

Once the plan is approved, `contract diff --check` lets the breaking change through in the provider's repository, only for the step that makes it and only after the steps before it are done.

## Run the plan

```bash
metator system plan run rename-refunds    # start the steps that can start
metator system status rename-refunds      # read the child runs back; done when every step is
```

Each step runs as its own run in its application's repository, with that repository's gates and approvals. No agent edits several repositories in one session. A step can start only when its application has a local checkout, so set `system.roots` first. The workflow around this is on [Change across applications](../use/system.md).

## Measure the planner

`docs/metator/evals/system/` holds small systems with a task and the expected result. Run them when you change the system agents or their prompts:

```bash
metator system eval list
metator system eval run                  # the tool alone
metator system eval run --host claude    # with the system agents
metator system eval run --min 0.95       # fail below this mean score
```
