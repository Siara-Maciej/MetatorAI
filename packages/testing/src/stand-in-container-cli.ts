import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A container of a stand-in engine's world. */
interface StandInContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  /** running, exited, created. */
  readonly state: string;
  readonly user?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly env?: readonly string[];
  readonly mounts?: readonly {
    readonly type: string;
    readonly source: string;
    readonly destination: string;
  }[];
}

export interface StandInWorld {
  readonly containers: readonly StandInContainer[];
  /** What `info` says is the server's version; none: the engine does not answer. */
  readonly serverVersion?: string;
  /** docker's current context. */
  readonly context?: string;
}

/**
 * A stand-in for a container CLI (never a real engine): a Bun script named `docker` or `nerdctl`
 * that answers `info`, `context show`, `ps -a -q --filter label=…`, `inspect`, `start` and
 * `exec [-i] [-u] [-w] [-e]…` from a world in a JSON file beside it, the way each CLI words them
 * (docker's names start with "/", nerdctl's do not; nerdctl's image is beside the config). `exec`
 * runs the program on this machine, in `-w`, with the container's environment and `-e` over this
 * process's own, and names the `-u` user in `STANDIN_USER`;
 * a stopped container refuses it as the engines do. Every call is appended to `calls.log`.
 * Returns the program's path.
 */
export function standInContainerCli(dir: string, dialect: "docker" | "nerdctl", world: StandInWorld): string {
  mkdirSync(dir, { recursive: true });
  const state = join(dir, `${dialect}-world.json`);
  writeFileSync(state, JSON.stringify(world));
  const file = join(dir, dialect);
  writeFileSync(
    file,
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const STATE = ${JSON.stringify(state)};
const DIALECT = ${JSON.stringify(dialect)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, "calls.log"))}, DIALECT + " " + args.join(" ") + "\\n");
const world = JSON.parse(readFileSync(STATE, "utf8"));
const save = () => writeFileSync(STATE, JSON.stringify(world));
const byId = (id) => world.containers.find((c) => c.id === id || c.id.startsWith(id) || c.name === id);
const fail = (text, code = 1) => { process.stderr.write(text + "\\n"); process.exit(code); };
const [verb, ...rest] = args;
if (verb === "info") {
  if (!world.serverVersion) fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
  console.log(world.serverVersion);
} else if (verb === "context" && rest[0] === "show") {
  console.log(world.context ?? "default");
} else if (verb === "ps") {
  const at = rest.indexOf("--filter");
  const label = at >= 0 ? rest[at + 1].replace(/^label=/, "") : undefined;
  for (const c of world.containers) if (label === undefined || c.labels[label] !== undefined) console.log(c.id);
} else if (verb === "inspect") {
  const out = [];
  for (const id of rest) {
    const c = byId(id);
    if (!c) fail("Error: No such object: " + id);
    const config = { User: c.user ?? "", Labels: c.labels, Env: c.env ?? [] };
    const mounts = (c.mounts ?? []).map((m) => ({ Type: m.type, Source: m.source, Destination: m.destination }));
    const status = { Status: c.state, Running: c.state === "running" };
    out.push(
      DIALECT === "docker"
        ? { Id: c.id, Name: "/" + c.name, Image: "sha256:0123", State: status, Config: { ...config, Image: c.image }, Mounts: mounts }
        : { Id: c.id, Name: c.name, Image: c.image, State: status, Config: config, Mounts: mounts },
    );
  }
  console.log(JSON.stringify(out, null, 2));
} else if (verb === "start") {
  for (const id of rest) {
    const c = byId(id);
    if (!c) fail("Error response from daemon: No such container: " + id);
    c.state = "running";
    console.log(id);
  }
  save();
} else if (verb === "exec") {
  let i = 0, user = "", cwd = process.cwd(), interactive = false;
  const env = {};
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-i") interactive = true;
    else if (a === "-u") user = rest[++i];
    else if (a === "-w") cwd = rest[++i];
    else if (a === "-e") { const kv = rest[++i]; const eq = kv.indexOf("="); env[kv.slice(0, eq)] = kv.slice(eq + 1); }
    else break;
  }
  const c = byId(rest[i]);
  if (!c) fail("Error response from daemon: No such container: " + rest[i]);
  if (c.state !== "running") fail("Error response from daemon: container " + c.id + " is not running");
  if (!existsSync(cwd)) fail("OCI runtime exec failed: chdir to cwd (\\"" + cwd + "\\") set in config.json failed: no such file or directory", 126);
  const argv = rest.slice(i + 1);
  let proc;
  try {
    proc = Bun.spawn(argv, {
      cwd,
      env: { ...process.env, ...Object.fromEntries((c.env ?? []).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])), ...env, STANDIN_USER: user, STANDIN_CONTAINER: c.id },
      stdin: interactive ? "inherit" : "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (e) {
    fail("OCI runtime exec failed: exec: " + argv[0] + ": executable file not found in $PATH", 127);
  }
  process.exit(await proc.exited);
} else {
  fail(DIALECT + ": '" + verb + "' is not a command of this stand-in");
}
`,
  );
  chmodSync(file, 0o755);
  return file;
}
