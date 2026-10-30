# Start the application in a worktree

**What for:** an agent that changed the API should see the API run, its integration tests pass and the web app talk to it. MetatorAI learns how your application starts, then starts it per worktree, on the worktree's own ports. Databases and brokers run **once** for every worktree, so a new worktree does not wait for a cold start of the whole backend.

## 1. Let MetatorAI find out how it starts

```bash
metator env discover
```

```json
{"environment":{"services":{
   "db":  {"source":{"compose":{"file":"docker-compose.yml","service":"db"}},"scope":"shared","ports":{"p5432":5432},"health":{"tcp":"p5432"}},
   "api": {"source":{"compose":{"file":"docker-compose.yml","service":"api"}},"scope":"worktree","needs":["db"],"ports":{"p3000":3000}},
   "web": {"source":{"script":"pnpm run dev","cwd":"apps/web"},"scope":"worktree","ports":{"http":5173},"health":{"http":"/"}}}},
 "evidence":[
   {"service":"db","from":"docker-compose.yml#services.db","reason":"infrastructure image postgres:16: one instance for every worktree","confidence":0.9},
   {"service":"web","from":"apps/web/package.json#scripts.dev","reason":"start script, port 5173 from its command","confidence":0.7}]}
```

**What it reads:**
- **Compose files.** An infrastructure image (Postgres, MySQL, Redis, Kafka, RabbitMQ, Elasticsearch, Mongo, …) without `build` becomes `shared`; anything built from the repository runs per worktree. `depends_on` becomes `needs`.
- **Start scripts** (`dev`, `start`, `serve`) of the root and every workspace package, run with your package manager. The port comes from the command, for example `--port 5173`.
- A **Procfile**, and a **Makefile** target when nothing else is found.

Nothing is started. When the proposal looks right:

```bash
metator env init          # writes metator/environment.yml; never overwrites
```

Review the file like code: scopes, ports and health checks are yours to decide.

## 2. The environment file

```yaml
kind: Environment
schemaVersion: 1
services:
  db:
    source: { compose: { file: docker-compose.yml, service: db } }
    scope: shared                 # one instance for every worktree
    ports: { pg: 5432 }
    health: { tcp: pg }
  api:
    source: { script: "pnpm run dev", cwd: apps/api }
    needs: [db]
    ports: { http: 3000 }         # outside a worktree; inside one, a port of its block
    health: { http: /health }
    env: { DATABASE_URL: "postgres://localhost:{port:db.pg}/shop" }
  storybook:
    source: { script: "pnpm run storybook" }
    scope: on-demand              # only when you ask for it
profiles:
  backend: [api]
```

Every process gets the ports of every service as `METATOR_PORT_<SERVICE>_<NAME>`, its own first port as `PORT`, and the worktree's `METATOR_WORKTREE` and `METATOR_PORT_BASE`. Read your port from `PORT`, or use `{port:<service>.<name>}` in `env`.

::: tip Compose and ports
Compose takes ports from the environment only where the file says so. Write `"${METATOR_PORT_API_HTTP:-3000}:3000"` instead of `"3000:3000"`, so two worktrees never ask for the same port.

A network the compose file declares `external: true` (the `docker network create shop-net` a README asks for) is created the first time a service needs it.
:::

## 3. Start, check, stop

```bash
metator env up --worktree 20261027-mt-feature-add-combined-discount
```

```json
{"services":[
  {"service":"db","place":"shared","status":"running","ports":{"pg":5432}},
  {"service":"api","place":"20261027-mt-feature-add-combined-discount","status":"started","ports":{"http":41000},"ms":2140}]}
```

```bash
metator env up storybook                 # an on-demand service (and what it needs)
metator env up --profile backend         # a named set
metator env status --worktree <id>       # where each service runs, whether it is up, its ports
metator env logs api --worktree <id>     # the last lines it wrote
metator env down --worktree <id>         # stop the worktree's services; shared ones stay
metator env down --shared                # also stop the shared services
```

**Why:**
- **Ready means ready.** `env up` waits for each service's health check (a TCP port or an HTTP answer), never for a fixed time. A service that never gets ready fails with the end of its log.
- **Shared once.** The second worktree finds the database running and starts only its own code.
- **Cleanup.** `metator worktree rm` stops the worktree's services first.

## 4. Start fast

A cold start installs dependencies, builds, migrates and seeds. Do it once, not in every worktree.

### Measure first

```bash
metator env analyze          # a cold and a warm start in throwaway worktrees, measured phase by phase
metator env analyze --cold   # restart running shared services first, so their start counts too
```

```json
{"cold":{"ms":8650},"warm":{"ms":410},"speedup":21.1,"criticalPath":["db","api"],
 "recommendations":[{"id":"reuse-build","service":"api","gainMs":4000,
   "evidence":"api: install took 4.0 s in a new worktree",
   "apply":"services.api.warm: { reuse: [node_modules] }"}]}
```

The profile is saved in `.metator/env-profile.json` (`EnvProfile`). Every recommendation carries the measurement it rests on and the time it saves. MetatorAI never edits `environment.yml` for you; you take a recommendation over yourself and measure again. The analysis removes its worktrees and stops what it started.

### Steps, data per worktree, reuse

```yaml
kind: Environment
schemaVersion: 2
services:
  db:
    source: { compose: { file: docker-compose.yml, service: db } }
    scope: shared
    ports: { pg: 5432 }
    health: { tcp: pg }
    init: [{ name: seed, run: "pnpm run db:seed" }]   # once, into the template ($METATOR_DATABASE)
    isolate: { postgres: { template: shop_seed, database: shop } }
  api:
    source: { script: "pnpm run dev", cwd: apps/api }
    needs: [db]
    paths: [apps/api, packages/shared]               # the code that is this service
    prepare: [{ name: install, run: "pnpm install --frozen-lockfile" }]
    init: [{ name: migrate, run: "pnpm run db:migrate" }]  # the run's own migrations, on its own database
    warm: { reuse: [node_modules] }                  # copied from your checkout while the lockfile matches
    env: { DATABASE_URL: "postgres://localhost:{port:db.pg}/{db:db}" }
```

| Field | What it does |
|---|---|
| `prepare` | steps before the service starts (install, build), each timed |
| `init` | steps after it is ready (migrations, seed). A shared service runs them once |
| `isolate.postgres` | `init` fills the `template` database once. Each worktree gets `wt_<id>`, cloned from it in seconds; your checkout gets `database`. `worktree rm` drops the worktree's database |
| `isolate: { prefix: true }` | `{prefix:<service>}` is `wt_<id>_` in a worktree and empty in your checkout: for keys, topics and queues |
| `warm.reuse` | directories copied from your checkout (copy-on-write where the disk can) when the `warm.key` files, by default the lockfiles, are equal. Never over what is there |
| `paths` | what `env up --affected` matches changed files against |

`{db:<service>}` is the place's database name. A Postgres password goes in `PGPASSWORD`.

### Only what the change touches

```bash
metator env up --worktree <id> --affected            # changes since the worktree left your HEAD
metator env up --affected --base main                # in your checkout, against a ref
```

Changed files, and every file that imports them, are matched against each service's `paths`. What matches starts, along with what it needs. A worktree service without `paths` always counts.

### A warm pool

```bash
metator env pool --size 2    # two worktrees on HEAD with everything already up
metator run init --workflow mt-feature --task "…" --worktree   # takes one: it moves to the run's branch
metator env pool             # free and taken pool worktrees
metator env pool --drain     # stop and remove the free ones
```

A run that takes a pool worktree skips the seed, the install and the start; `env pool --size 2` tops the pool up again.
