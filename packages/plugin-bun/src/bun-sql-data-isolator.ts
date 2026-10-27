import {
  type DataIsolator,
  DB_NAME,
  err,
  MetatorError,
  ok,
  type PostgresTarget,
  type Result,
} from "@metator/core";
import { SQL } from "bun";

/**
 * DataIsolator on Bun's built-in Postgres client (F8.7, ADR-0055). It connects to the `postgres`
 * database as the target's user; a password comes from PGPASSWORD. Names match DB_NAME, so they
 * are safe to put in the statement quoted.
 */
export class BunSqlDataIsolator implements DataIsolator {
  async createDatabase(
    target: PostgresTarget,
    name: string,
    template?: string,
  ): Promise<Result<boolean, MetatorError>> {
    const bad = [name, template].find((n) => n !== undefined && !DB_NAME.test(n));
    if (bad !== undefined) return err(MetatorError.usage(`not a database name MetatorAI creates: ${bad}`));
    return this.with(target, `create database ${name}`, async (sql) => {
      if (await exists(sql, name)) return false;
      await sql.unsafe(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ""}`);
      return true;
    });
  }

  async dropDatabase(target: PostgresTarget, name: string): Promise<Result<boolean, MetatorError>> {
    if (!DB_NAME.test(name)) return err(MetatorError.usage(`not a database name MetatorAI creates: ${name}`));
    return this.with(target, `drop database ${name}`, async (sql) => {
      if (!(await exists(sql, name))) return false;
      // FORCE ends what still connects to it (Postgres 13+): the worktree is going away.
      await sql.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      return true;
    });
  }

  private async with<T>(
    target: PostgresTarget,
    what: string,
    run: (sql: SQL) => Promise<T>,
  ): Promise<Result<T, MetatorError>> {
    const sql = new SQL({
      hostname: target.host,
      port: target.port,
      username: target.user,
      database: "postgres",
      max: 1,
      connectionTimeout: 10,
    });
    try {
      // A Postgres that just opened its port may still be starting up: that passes in seconds.
      for (let attempt = 1; ; attempt++) {
        try {
          return ok(await run(sql));
        } catch (e) {
          if (attempt < STARTUP_RETRIES && startingUp(e)) {
            await Bun.sleep(200);
            continue;
          }
          return err(
            new MetatorError(
              "COMMAND_FAILED",
              `${what} on ${target.host}:${target.port}: ${(e as Error).message}`,
              { hint: "Is the shared Postgres up (`metator env status`)? A password goes in PGPASSWORD." },
            ),
          );
        }
      }
    } finally {
      await sql.close();
    }
  }
}

const STARTUP_RETRIES = 150;

/** SQLSTATE 57P03 (cannot_connect_now): the server is starting up or recovering. */
function startingUp(e: unknown): boolean {
  const x = e as { errno?: string; code?: string; message?: string };
  return x.errno === "57P03" || /starting up|not yet accepting/i.test(x.message ?? "");
}

async function exists(sql: SQL, name: string): Promise<boolean> {
  const rows = await sql`select 1 from pg_database where datname = ${name}`;
  return rows.length > 0;
}
