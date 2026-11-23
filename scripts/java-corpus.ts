/**
 * The Java reader on real code (ADR-0107): downloads source jars from Maven Central into a cache,
 * parses every `.java` file with the parser `metator java` uses, and reports the parse rate, the
 * files that did not fully parse, files per second and memory. With `--cli`, it also lays the
 * corpus out as one Maven build (each jar a module, `--copies N` times over for an enterprise-sized
 * repository) and times the real `metator java index` on it, cold and with its cache.
 * Not part of `bun run check`: it needs the network once and takes a minute.
 *
 * Usage: bun scripts/java-corpus.ts [--cache <dir>] [--cli] [--copies N] [--json]
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { TreeSitterJavaParser } from "../packages/plugin-java/src/tree-sitter-java-parser.ts";

const ROOT = resolve(import.meta.dir, "..");

/** group:artifact:version of each source jar: Spring MVC/WebFlux/Data JPA, Hibernate, JAX-RS, Guava, and Lucene 10 (Java 21: records, sealed types, switch patterns). */
export const CORPUS = [
  "org.springframework:spring-webmvc:6.1.14",
  "org.springframework:spring-webflux:6.1.14",
  "org.springframework.data:spring-data-jpa:3.3.5",
  "org.hibernate.orm:hibernate-core:6.6.1.Final",
  "jakarta.ws.rs:jakarta.ws.rs-api:3.1.0",
  "com.google.guava:guava:33.3.1-jre",
  "org.apache.lucene:lucene-core:10.1.0",
] as const;

const REPOSITORY = "https://repo1.maven.org/maven2";

export function sourcesUrl(coordinate: string): string {
  const [group, artifact, version] = coordinate.split(":") as [string, string, string];
  return `${REPOSITORY}/${group.replaceAll(".", "/")}/${artifact}/${version}/${artifact}-${version}-sources.jar`;
}

/** Downloads one jar into the cache (once), retrying when Maven Central asks to slow down (429). */
async function download(coordinate: string, cache: string): Promise<string> {
  const file = join(cache, "jars", `${coordinate.replaceAll(":", "_")}-sources.jar`);
  if (existsSync(file)) return file;
  await mkdir(join(cache, "jars"), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(sourcesUrl(coordinate));
    if (response.ok) {
      await Bun.write(file, await response.arrayBuffer());
      return file;
    }
    if (response.status !== 429 || attempt === 6)
      throw new Error(`${sourcesUrl(coordinate)}: HTTP ${response.status}`);
    await Bun.sleep(attempt * 5_000);
  }
}

/** The jar's `.java` files, unpacked once into the cache (`unzip`). */
async function unpack(jar: string, cache: string, coordinate: string): Promise<string> {
  const dir = join(cache, "src", coordinate.split(":")[1] as string);
  if (existsSync(join(dir, ".done"))) return dir;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const unzip = Bun.spawnSync(["unzip", "-q", "-o", jar, "*.java", "-d", dir], { stderr: "pipe" });
  if (unzip.exitCode !== 0)
    throw new Error(`unzip ${jar} failed (is unzip installed?): ${unzip.stderr.toString()}`);
  await Bun.write(join(dir, ".done"), "");
  return dir;
}

async function javaFiles(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true }))
    .filter((f) => f.endsWith(".java"))
    .map((f) => join(dir, f))
    .sort();
}

export interface ProjectReport {
  readonly coordinate: string;
  readonly files: number;
  readonly megabytes: number;
  readonly failed: number;
  readonly failures: readonly string[];
  readonly ms: number;
  readonly filesPerSecond: number;
  readonly types: number;
}

async function parseProject(
  parser: TreeSitterJavaParser,
  coordinate: string,
  dir: string,
  peak: { rss: number },
): Promise<ProjectReport> {
  const files = await javaFiles(dir);
  let bytes = 0;
  let failed = 0;
  let types = 0;
  const failures: string[] = [];
  const started = performance.now();
  for (const file of files) {
    const text = await Bun.file(file).text();
    bytes += text.length;
    const parsed = await parser.parse(relative(dir, file), text);
    if (parsed.isErr()) throw new Error(parsed.error.message);
    types += parsed.value.types.length;
    if (parsed.value.error) {
      failed++;
      if (failures.length < 5)
        failures.push(`${relative(dir, file)}:${parsed.value.error.line ?? 0} ${parsed.value.error.message}`);
    }
    peak.rss = Math.max(peak.rss, process.memoryUsage().rss);
  }
  const ms = performance.now() - started;
  return {
    coordinate,
    files: files.length,
    megabytes: bytes / 1e6,
    failed,
    failures,
    ms,
    filesPerSecond: files.length / (ms / 1000),
    types,
  };
}

/** The corpus as one Maven build (`<copies>` modules per jar) in a temporary folder. */
async function layOut(
  sources: readonly { coordinate: string; dir: string }[],
  copies: number,
  at: string,
): Promise<number> {
  await rm(at, { recursive: true, force: true });
  const modules: string[] = [];
  let files = 0;
  for (let c = 0; c < copies; c++)
    for (const s of sources) {
      const name = `${s.coordinate.split(":")[1]}-${c}`;
      modules.push(name);
      const target = join(at, name, "src/main/java");
      await mkdir(target, { recursive: true });
      const cp = Bun.spawnSync(["cp", "-R", `${s.dir}/.`, target]);
      if (cp.exitCode !== 0) throw new Error(`cp ${s.dir} failed`);
      await Bun.write(
        join(at, name, "pom.xml"),
        `<project><modelVersion>4.0.0</modelVersion><artifactId>${name}</artifactId></project>\n`,
      );
      files += (await javaFiles(target)).length;
    }
  await Bun.write(
    join(at, "pom.xml"),
    `<project><modelVersion>4.0.0</modelVersion><groupId>corpus</groupId><artifactId>corpus</artifactId><version>1</version><packaging>pom</packaging><modules>${modules.map((m) => `<module>${m}</module>`).join("")}</modules></project>\n`,
  );
  return files;
}

/** Peak resident memory of a running process (Linux `/proc`), polled until it exits. */
async function peakRssMb(pid: number, exited: Promise<number>): Promise<number | undefined> {
  let peak: number | undefined;
  let done = false;
  void exited.then(() => {
    done = true;
  });
  while (!done) {
    const status = await Bun.file(`/proc/${pid}/status`)
      .text()
      .catch(() => "");
    const kb = Number(/VmHWM:\s+(\d+)/.exec(status)?.[1]);
    if (Number.isFinite(kb) && kb > 0) peak = kb / 1024;
    await Bun.sleep(50);
  }
  return peak;
}

/** `metator java index` on the laid-out corpus: wall time, peak memory (Linux) and its answer. */
async function timeIndex(
  at: string,
): Promise<{ ms: number; peakRssMb?: number; data: Record<string, unknown> }> {
  const cli = join(ROOT, "packages/cli/src/main.ts");
  const started = performance.now();
  const run = Bun.spawn(["bun", cli, "-C", at, "java", "index", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, METATOR_NO_REAL_HOSTS: "1" },
  });
  const [stdout, stderr, peak, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    peakRssMb(run.pid, run.exited),
    run.exited,
  ]);
  const ms = performance.now() - started;
  if (code !== 0) throw new Error(`metator java index failed: ${stderr}`);
  return {
    ms,
    ...(peak !== undefined ? { peakRssMb: peak } : {}),
    data: (JSON.parse(stdout) as { data: Record<string, unknown> }).data,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const cache = resolve(
    opt("--cache") ?? process.env.METATOR_JAVA_CORPUS ?? join(homedir(), ".cache/metator/java-corpus"),
  );
  const copies = Number(opt("--copies") ?? "1");
  const parser = new TreeSitterJavaParser();
  const peak = { rss: process.memoryUsage().rss };
  const sources: { coordinate: string; dir: string }[] = [];
  const reports: ProjectReport[] = [];
  for (const coordinate of CORPUS) {
    const dir = await unpack(await download(coordinate, cache), cache, coordinate);
    sources.push({ coordinate, dir });
    reports.push(await parseProject(parser, coordinate, dir, peak));
  }
  const files = reports.reduce((n, r) => n + r.files, 0);
  const failed = reports.reduce((n, r) => n + r.failed, 0);
  const ms = reports.reduce((n, r) => n + r.ms, 0);
  const totals = {
    parser: TreeSitterJavaParser.id,
    files,
    megabytes: reports.reduce((n, r) => n + r.megabytes, 0),
    failed,
    parsedFully: (100 * (files - failed)) / files,
    filesPerSecond: files / (ms / 1000),
    seconds: ms / 1000,
    peakRssMb: peak.rss / 1e6,
  };
  let cli: Record<string, unknown> | undefined;
  if (args.includes("--cli")) {
    const at = join(cache, `repo-x${copies}`);
    const laidOut = await layOut(sources, copies, at);
    const cold = await timeIndex(at);
    const warm = await timeIndex(at);
    const index = join(at, ".metator/index/java.json");
    cli = { files: laidOut, cold, warm, indexMb: existsSync(index) ? (await stat(index)).size / 1e6 : 0 };
  }
  if (args.includes("--json")) console.log(JSON.stringify({ reports, totals, cli }, null, 2));
  else {
    for (const r of reports)
      console.log(
        `${r.coordinate}: ${r.files} files (${r.megabytes.toFixed(1)} MB), ${r.failed} not fully parsed, ${r.filesPerSecond.toFixed(0)} files/s, ${r.types} types${r.failures.length > 0 ? `\n    ${r.failures.join("\n    ")}` : ""}`,
      );
    console.log(
      `TOTAL ${totals.parser}: ${files} files, ${totals.megabytes.toFixed(1)} MB, ${failed} not fully parsed (${totals.parsedFully.toFixed(2)}% fully parsed), ${totals.filesPerSecond.toFixed(0)} files/s, ${totals.seconds.toFixed(1)} s, peak RSS ${totals.peakRssMb.toFixed(0)} MB`,
    );
    if (cli) console.log(`metator java index on ${cli.files} files: ${JSON.stringify(cli)}`);
  }
}
