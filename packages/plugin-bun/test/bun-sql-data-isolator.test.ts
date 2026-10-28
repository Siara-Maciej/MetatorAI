import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dataIsolatorContract, findPostgresBin, type PostgresServer, startPostgres } from "@metator/testing";
import { SQL } from "bun";
import { BunSqlDataIsolator } from "../src/bun-sql-data-isolator.ts";

// A real Postgres where the machine has one (CI runners and the dev container do).
const bin = findPostgresBin();
let server: PostgresServer | undefined;
beforeAll(async () => {
  if (bin) server = await startPostgres(bin);
}, 60_000);
afterAll(async () => {
  await server?.stop();
});

const target = () => ({ host: "127.0.0.1", port: server?.port ?? 0, user: "postgres" });
const connect = (database: string) =>
  new SQL({ hostname: "127.0.0.1", port: server?.port ?? 0, username: "postgres", database, max: 1 });

describe.skipIf(!bin)("BunSqlDataIsolator (real Postgres)", () => {
  dataIsolatorContract("BunSqlDataIsolator", async () => ({
    isolator: new BunSqlDataIsolator(),
    target: target(),
    insert: async (db, value) => {
      const sql = connect(db);
      await sql`create table if not exists t (x int)`;
      await sql`insert into t values (${value})`;
      await sql.close();
    },
    rows: async (db) => {
      const sql = connect(db);
      const rows = (await sql`select x from t order by x desc`) as { x: number }[];
      await sql.close();
      return rows.map((r) => r.x).sort((a, b) => (a === 42 ? -1 : b === 42 ? 1 : a - b));
    },
  }));

  test("drop ends open connections; names that would need quoting are refused", async () => {
    const isolator = new BunSqlDataIsolator();
    await isolator.createDatabase(target(), "busy");
    const sql = connect("busy");
    await sql`select 1`;
    expect((await isolator.dropDatabase(target(), "busy"))._unsafeUnwrap()).toBe(true);
    await sql.close().catch(() => {});
    expect(
      (await isolator.createDatabase(target(), 'x"; drop database postgres; --'))._unsafeUnwrapErr().code,
    ).toBe("USAGE");
  });
});

test("an unreachable server is an error value with the next step", async () => {
  const r = await new BunSqlDataIsolator().createDatabase(
    { host: "127.0.0.1", port: 1, user: "postgres" },
    "x",
  );
  expect(r._unsafeUnwrapErr().hint).toContain("metator env status");
});
