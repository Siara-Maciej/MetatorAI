import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real, throwaway Postgres for tests of data isolation (F8.7). Found in `pg_config --bindir` or
 * /usr/lib/postgresql/<n>/bin; undefined when the machine has none. Postgres refuses to run as
 * root, so under root it runs as the `postgres` user.
 */
export function findPostgresBin(): string | undefined {
  const fromConfig = Bun.spawnSync(["sh", "-c", "pg_config --bindir 2>/dev/null"]).stdout.toString().trim();
  const candidates = [
    fromConfig,
    ...[18, 17, 16, 15, 14, 13].map((v) => `/usr/lib/postgresql/${v}/bin`),
  ].filter(Boolean);
  return candidates.find((dir) => existsSync(join(dir, "postgres")) && existsSync(join(dir, "initdb")));
}

const asRoot = () => process.getuid?.() === 0;

/**
 * A shell script that creates a trust-auth cluster in `dataDir` on first start and runs Postgres in
 * the foreground on 127.0.0.1:$PORT (or `port`), without a Unix socket.
 */
export function postgresScript(bin: string, dataDir: string, port?: number): string {
  const as = asRoot() ? "runuser -u postgres -- " : "";
  return [
    "#!/bin/sh",
    "set -e",
    `D="${dataDir}"`,
    `if [ ! -f "$D/PG_VERSION" ]; then mkdir -p "$D"; ${asRoot() ? 'chown postgres "$D"; ' : ""}${as}"${bin}/initdb" -D "$D" -U postgres --auth=trust -E UTF8 >/dev/null; fi`,
    `exec ${as}"${bin}/postgres" -D "$D" -h 127.0.0.1 -p ${port ?? '"$PORT"'} -k "" -c fsync=off`,
    "",
  ].join("\n");
}

export interface PostgresServer {
  readonly port: number;
  stop(): Promise<void>;
}

/** Starts a Postgres on a free port and waits until it accepts connections. */
export async function startPostgres(bin: string): Promise<PostgresServer> {
  const dir = await mkdtemp(join(tmpdir(), "metator-pg-"));
  if (asRoot()) await chmod(dir, 0o777);
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  const script = join(dir, "pg.sh");
  await Bun.write(script, postgresScript(bin, join(dir, "data"), port));
  const proc = Bun.spawn(["sh", script], { stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 200; i++) {
    const ready = Bun.spawnSync([join(bin, "pg_isready"), "-h", "127.0.0.1", "-p", String(port)]);
    if (ready.exitCode === 0) break;
    if (proc.exitCode !== null) throw new Error(`postgres exited: ${await new Response(proc.stderr).text()}`);
    await Bun.sleep(100);
  }
  return {
    port,
    async stop() {
      // Through runuser a signal may not reach Postgres; pg_ctl talks to it directly.
      const as = asRoot() ? ["runuser", "-u", "postgres", "--"] : [];
      Bun.spawnSync([...as, join(bin, "pg_ctl"), "-D", join(dir, "data"), "stop", "-m", "immediate"]);
      await proc.exited;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
