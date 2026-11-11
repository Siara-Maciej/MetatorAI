# Run the application

MetatorAI can start your application in a run's worktree, on that worktree's own ports, so an agent can check its change against the running API or web app. Databases and brokers start once and serve every worktree. You do not need this when lint, typecheck and tests are enough to check a change.

## Discover how the application starts

```bash
metator env discover
```

This prints a proposed environment with the evidence for each service. It starts nothing. It reads:

- Compose files. An infrastructure image (Postgres, Redis, Kafka and the like) without `build` becomes a `shared` service. Anything built from the repository runs per worktree. `depends_on` becomes `needs`.
- Start scripts (`dev`, `start`, `serve`) of the root and of every workspace package. The port comes from the command, for example `--port 5173`.
- A Procfile, and a Makefile target when nothing else is found.

When the proposal looks right, write it:

```bash
metator env init          # writes metator/environment.yml; never overwrites
```

Review the file like code. Scopes, ports and health checks are yours to decide.

## The environment file

```yaml
# metator/environment.yml
kind: Environment
schemaVersion: 2
services:
  db:
    source: { compose: { file: docker-compose.yml, service: db } }
    scope: shared
    ports: { pg: 5432 }
    health: { tcp: pg }
  api:
    source: { script: "pnpm run dev", cwd: apps/api }
    needs: [db]
    ports: { http: 3000 }
    health: { http: /health }
    env: { DATABASE_URL: "postgres://localhost:{port:db.pg}/shop" }
  storybook:
    source: { script: "pnpm run storybook" }
    scope: on-demand
profiles:
  backend: [api]
```

| Key | Meaning |
|---|---|
| `source` | a Compose service (`compose.file`, `compose.service`) or a command (`script`, optional `cwd`) |
| `scope` | `worktree` (default): one per worktree. `shared`: one for every worktree. `on-demand`: only when you name it |
| `needs` | services that must be ready first |
| `ports` | named ports. In your checkout they are the numbers you wrote; in a worktree, ports from the worktree's block |
| `health` | `tcp: <port name>` or `http: <path>`: how MetatorAI knows the service is ready |
| `readyTimeoutMs` | how long to wait for the health check (default `120000`) |
| `env` | extra variables; `{port:<service>.<name>}` is replaced with the real port |
| `profiles` | named sets of services for `env up --profile` |

Every process gets these variables:

| Variable | Value |
|---|---|
| `PORT` | the service's own first port |
| `METATOR_PORT_<SERVICE>_<NAME>` | the port of every service, for example `METATOR_PORT_DB_PG` |
| `METATOR_WORKTREE`, `METATOR_PORT_BASE` | the worktree's id and the start of its port block |

Compose takes a port from the environment only where the file says so. Write `"${METATOR_PORT_API_HTTP:-3000}:3000"` instead of `"3000:3000"`, or two worktrees ask for the same port.

## Start, check, stop

```bash
metator env up --worktree <id>           # the worktree's services and what they need
metator env up storybook                 # one service by name, in this checkout
metator env up --profile backend         # a named set
metator env status --worktree <id>       # where each service runs, whether it is up, its ports
metator env logs api --worktree <id>     # the last 50 lines it wrote (--lines <n>)
metator env down --worktree <id>         # stop the worktree's services; shared ones stay
metator env down --shared                # also stop the shared services
```

Without `--worktree`, a command acts on your checkout.

`env up` starts services in the order of their `needs` and waits for each health check. A service that does not get ready in time fails with the end of its log. A second worktree finds the shared services running and starts only its own.

::: warning
`env down --shared` stops services that other worktrees may be using, and a shared database serves all of them. Stop shared services only when no other run needs them.
:::

## Start faster

A cold start installs dependencies, builds, migrates and seeds. Measure before you tune:

```bash
metator env analyze          # a cold and a warm start in throwaway worktrees
metator env analyze --cold   # restart running shared services first, so their start counts too
```

The result is saved in `.metator/env-profile.json`. It gives the cold and warm times and a list of recommendations, each with the measurement behind it and the change to make in `environment.yml`. MetatorAI does not edit the file for you. The analysis removes its worktrees and stops what it started.

These keys cut the start time:

```yaml
services:
  db:
    source: { compose: { file: docker-compose.yml, service: db } }
    scope: shared
    ports: { pg: 5432 }
    health: { tcp: pg }
    init: [{ name: seed, run: "pnpm run db:seed" }]
    isolate: { postgres: { template: shop_seed, database: shop } }
  api:
    source: { script: "pnpm run dev", cwd: apps/api }
    needs: [db]
    paths: [apps/api, packages/shared]
    prepare: [{ name: install, run: "pnpm install --frozen-lockfile" }]
    init: [{ name: migrate, run: "pnpm run db:migrate" }]
    warm: { reuse: [node_modules] }
    env: { DATABASE_URL: "postgres://localhost:{port:db.pg}/{db:db}" }
```

| Key | Meaning |
|---|---|
| `prepare` | steps before the service starts, such as install or build |
| `init` | steps after it is ready, such as migrations or a seed. A shared service runs them once |
| `isolate.postgres` | `init` fills the `template` database once. Each worktree gets its own database cloned from it (`wt_<id>`), and your checkout gets `database`. Use `{db:<service>}` for the name |
| `isolate: { prefix: true }` | `{prefix:<service>}` is a per-worktree prefix for keys, topics and queues, and empty in your checkout |
| `warm.reuse` | directories copied from your checkout into a new worktree while the `warm.key` files match |
| `paths` | the code that is this service, for `--affected` |

## Start only what the change touches

```bash
metator env up --worktree <id> --affected     # changes since the worktree branched off
metator env up --affected --base main         # in your checkout, against a ref
```

Changed files are matched against each service's `paths`. Matching services start, with what they need.

## Keep worktrees ready

```bash
metator env pool --size 2    # keep two free worktrees with their services up
metator env pool             # show free and taken pool worktrees
metator env pool --drain     # stop and remove the free ones
```

A run started with `metator run init ... --worktree` takes a free pool worktree instead of starting from cold. Run `env pool --size 2` again to top the pool up. Worktrees themselves are on [Sessions and worktrees](../use/sessions.md).
