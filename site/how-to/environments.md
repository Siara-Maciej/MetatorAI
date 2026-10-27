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
