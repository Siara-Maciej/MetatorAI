/**
 * Mutation smoke test: injects known bugs one at a time and requires the unit suite to fail.
 * A surviving mutant means tests stopped protecting that behavior. A missing pattern means
 * the code changed and the mutant list needs an update. Both fail the run.
 *
 * Mutants run in parallel, each worker in its own copy of the repository, so the working tree is
 * never touched (an interrupted run cannot leave a bug behind). A worker proves its copy first: the
 * unmutated suite must pass there.
 *
 * Usage: bun scripts/mutation-smoke.ts [file filter] [--jobs N]
 */
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MUTANTS, type Mutant } from "./mutants.ts";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const jobsAt = args.indexOf("--jobs");
const jobs = Math.max(1, jobsAt >= 0 ? Number(args[jobsAt + 1]) : availableParallelism());
const filter = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--jobs");
const selected = filter ? MUTANTS.filter((m) => m.file.includes(filter)) : MUTANTS;

let failures = 0;
const queue: Mutant[] = [];
for (const m of selected) {
  if (!(await Bun.file(join(ROOT, m.file)).text()).includes(m.from)) {
    console.error(`STALE   ${m.file}: pattern not found (${m.why})`);
    failures++;
  } else queue.push(m);
}

/** Files of the working tree: tracked and untracked, without what git ignores. */
function sourceFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT });
  return out.stdout.toString().split("\0").filter(Boolean);
}

/**
 * The copy's node_modules: links to the real packages, except workspace links (relative), which
 * are recreated as they are so they point at the copy's own packages.
 */
async function mirrorModules(real: string, copy: string): Promise<void> {
  await mkdir(copy, { recursive: true });
  for (const name of readdirSync(real)) {
    const from = join(real, name);
    const to = join(copy, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(from);
      await symlink(target, to); // relative workspace links resolve inside the copy
    } else if (stat.isDirectory() && name.startsWith("@")) await mirrorModules(from, to);
    else await symlink(from, to);
  }
}

async function prepare(files: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "metator-mutants-"));
  for (const f of files) {
    await mkdir(dirname(join(dir, f)), { recursive: true });
    await Bun.write(join(dir, f), Bun.file(join(ROOT, f)));
  }
  const modules = [
    "node_modules",
    ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/node_modules`),
  ];
  for (const m of modules) {
    try {
      lstatSync(join(ROOT, m));
    } catch {
      continue;
    }
    await mirrorModules(join(ROOT, m), join(dir, m));
  }
  return dir;
}

const suite = (cwd: string) =>
  Bun.spawn(["bun", "test", "--bail", "packages"], { cwd, stdout: "ignore", stderr: "ignore" }).exited;

const files = sourceFiles();
const dirs: string[] = [];
const cleanup = async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
};
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

try {
  const workers = Math.min(jobs, Math.max(1, queue.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      const dir = await prepare(files);
      dirs.push(dir);
      if ((await suite(dir)) !== 0) {
        console.error(`BROKEN  the unmutated suite fails in the copy ${dir}; mutants cannot be judged`);
        failures++;
        return;
      }
      for (let m = queue.shift(); m; m = queue.shift()) {
        const path = join(dir, m.file);
        const original = await Bun.file(path).text();
        await Bun.write(path, original.replace(m.from, m.to));
        const killed = (await suite(dir)) !== 0;
        await Bun.write(path, original);
        console.log(`${killed ? "KILLED " : "SURVIVED"} ${m.file}: ${m.why}`);
        if (!killed) failures++;
      }
    }),
  );
} finally {
  await cleanup();
}

if (failures > 0) {
  console.error(`\n${failures} mutant(s) survived or are stale: strengthen the tests or update the list.`);
  process.exit(1);
}
console.log(`\nAll ${selected.length} mutants killed.`);
