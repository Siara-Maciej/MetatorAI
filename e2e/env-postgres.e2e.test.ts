/**
 * Data isolation end to end (F8.7): a real Postgres runs as the shared service; its `init` seeds
 * a template once; every worktree gets its own database cloned from it, and loses it with
 * `worktree rm`. Runs where the machine has Postgres (CI runners and the dev container do).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPostgresBin, postgresScript } from "@metator/testing";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const bin = findPostgresBin();
let repo: ScratchRepo;
let dataDir: string;
let pgPort = 0;
const mt = (...args: string[]) => metator(args, repo.root);
const psql = (db: string, sql: string) =>
  Bun.spawnSync([
    join(bin ?? "", "psql"),
    "-h",
    "127.0.0.1",
    "-p",
    String(pgPort),
    "-U",
    "postgres",
    "-d",
    db,
    "-tAc",
    sql,
  ]);
const rows = (db: string, sql: string) => psql(db, sql).stdout.toString().trim();

beforeAll(async () => {
  if (!bin) return;
  repo = await ScratchRepo.create();
  // Postgres refuses to run as root; under root it runs as `postgres`, which must reach the data.
  dataDir = await mkdtemp(join(tmpdir(), "metator-pg-e2e-"));
  await chmod(dataDir, 0o777);
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  pgPort = probe.port;
  probe.stop(true);
  await repo.write(".gitignore", ".metator/\n");
  await repo.write("pg.sh", postgresScript(bin, join(dataDir, "data")));
  await repo.write(
    "seed.sh",
    `"${bin}/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d "$METATOR_DATABASE" -c "create table orders (id int); insert into orders values (42);"\n`,
  );
  await repo.write(
    "serve.ts",
    "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response(process.env.DATABASE_URL) });\n",
  );
  await repo.write(
    "metator/environment.yml",
    `kind: Environment
schemaVersion: 2
services:
  db:
    source: { script: "sh pg.sh" }
    scope: shared
    ports: { pg: ${pgPort} }
    health: { tcp: pg }
    init: [{ name: seed, run: "sh seed.sh" }]
    isolate: { postgres: { template: shop_seed, database: shop } }
  api:
    source: { script: "bun serve.ts" }
    needs: [db]
    ports: { http: 3000 }
    health: { http: / }
    env: { DATABASE_URL: "postgres://postgres@127.0.0.1:{port:db.pg}/{db:db}" }
`,
  );
  await repo.commit("init");
}, 60_000);
afterAll(async () => {
  if (!bin) return;
  for (const wt of ["one", "two"]) await mt("env", "down", "--worktree", wt);
  await mt("env", "down", "--shared");
  await repo.dispose();
  await rm(dataDir, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!bin)("data isolation on a real Postgres (real CLI)", () => {
  test("the template is seeded once; each worktree works on its own clone", async () => {
    await mt("worktree", "new", "one");
    await mt("worktree", "new", "two");
    const one = await mt("env", "up", "--worktree", "one");
    expect(one.code).toBe(0);
    const phases = (one.json.data as { services: { service: string; phases: { name: string }[] }[] })
      .services;
    expect(phases.map((s) => [s.service, s.phases.map((p) => p.name)])).toEqual([
      ["db", ["start", "template", "seed"]],
      ["api", ["isolate", "start"]],
    ]);
    expect((await mt("env", "up", "--worktree", "two")).code).toBe(0);
    const api = async (wt: string) =>
      (
        (await mt("env", "status", "--worktree", wt)).json.data as {
          services: { service: string; ports: { http: number } }[];
        }
      ).services.find((s) => s.service === "api")?.ports.http;
    expect(await (await fetch(`http://127.0.0.1:${await api("one")}/`)).text()).toBe(
      `postgres://postgres@127.0.0.1:${pgPort}/wt_one`,
    );
    // Both clones start from the seed; a write in one never reaches the other or the template.
    expect([rows("wt_one", "select id from orders"), rows("wt_two", "select id from orders")]).toEqual([
      "42",
      "42",
    ]);
    psql("wt_one", "insert into orders values (7)");
    expect([
      rows("wt_one", "select count(*) from orders"),
      rows("wt_two", "select count(*) from orders"),
      rows("shop_seed", "select count(*) from orders"),
    ]).toEqual(["2", "1", "1"]);
  }, 120_000);

  test("worktree rm drops its database; the others and the template stay", async () => {
    const rm1 = await mt("worktree", "rm", "one", "--force");
    expect((rm1.json.data as { droppedData: string[] }).droppedData).toEqual(["wt_one"]);
    expect(
      rows(
        "postgres",
        "select datname from pg_database where datname like 'wt_%' or datname = 'shop_seed' order by 1",
      ),
    ).toBe("shop_seed\nwt_two");
  }, 60_000);
});
