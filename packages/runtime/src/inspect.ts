import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommitSetup,
  DEFAULT_CONFIG,
  DEFAULT_PATHS,
  err,
  foldWorktrees,
  IN_DEVCONTAINER_ENV,
  InspectFolder,
  MetatorConfigDocument,
  MetatorError,
  ok,
  parseYamlDocument,
  proposeRepoSet,
  REPO_SET_FILE,
  RepoSetDocument,
  type Result,
  reposOf,
} from "@metator/core";
import { BunLauncher, BunProcessRunner, findFolderRepos, readCheckout } from "@metator/plugin-bun";
import { GitCliRepository } from "@metator/plugin-git";
import { type BootstrapOptions, bootstrap, HOSTS } from "./bootstrap.ts";
import { METATOR_VERSION } from "./canon.ts";

/**
 * `metator inspect <path>` and `setup --commit` (ADR-0105) as the composition root builds them:
 * inspect runs on any folder, a repository or not, so it does not take a repository's container.
 */

/** What a file system path is: a folder, a file, or nothing. */
function kindOf(path: string): "dir" | "file" | undefined {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The folder of repositories at exactly `path`: its file's repositories, else the ones below it. */
function folderAt(path: string): Result<{ file: string | null; roots: string[] } | null, MetatorError> {
  const file = join(path, REPO_SET_FILE);
  if (existsSync(file)) {
    const set = parseYamlDocument(readText(file) ?? "", REPO_SET_FILE).andThen((raw) =>
      RepoSetDocument.parse(raw, REPO_SET_FILE),
    );
    if (set.isErr()) return err(set.error);
    const { repos, problems } = reposOf(set.value);
    if (problems.length > 0)
      return err(new MetatorError("INVALID_CONFIG", `${REPO_SET_FILE}: ${problems.join("; ")}`));
    const folded = foldWorktrees(repos, (p) => readCheckout(join(path, p)));
    return ok({ file, roots: folded.repos.map((r) => join(path, r.path)) });
  }
  const found = reposOf(proposeRepoSet(findFolderRepos(path))).repos;
  return ok(found.length > 0 ? { file: null, roots: found.map((r) => join(path, r.path)) } : null);
}

/**
 * What `setup --host <host>` writes, from a setup done in a scratch folder that is removed after:
 * the same canon and the same steps, so the same paths a real setup reports in `written`. The
 * repository's `.gitignore` is copied in first: one that already ignores `.metator/` is not written.
 */
async function previewSetup(
  options: Omit<BootstrapOptions, "root" | "config">,
  host: "copilot" | "claude",
  root: string | undefined,
): Promise<Result<readonly string[], MetatorError>> {
  const scratch = await mkdtemp(join(tmpdir(), "metator-setup-preview-"));
  try {
    const ignore = root === undefined ? undefined : readText(join(root, ".gitignore"));
    if (ignore !== undefined) await writeFile(join(scratch, ".gitignore"), ignore);
    const c = bootstrap({ ...options, root: scratch, config: { config: DEFAULT_CONFIG, source: undefined } });
    const done = await c.resolve("setupRepository").execute({ hosts: [host], hooks: true });
    return done.map((r) => r.report.written);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function folderInspector(
  options: Omit<BootstrapOptions, "root" | "config">,
  env: Readonly<Record<string, string | undefined>>,
): InspectFolder {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return new InspectFolder({
    version: METATOR_VERSION,
    configVersion: MetatorConfigDocument.current,
    installLock: DEFAULT_PATHS.installLock,
    hostOrder: DEFAULT_CONFIG.supervisor.hostOrder,
    hosts: HOSTS,
    inContainer: env[IN_DEVCONTAINER_ENV] === "1",
    installed: (programs) => new BunLauncher().available(programs),
    env,
    readHome: (path) => {
      const text = readText(join(home, path));
      if (text === undefined) return undefined;
      try {
        return { json: JSON.parse(text) as unknown };
      } catch {
        return { json: undefined };
      }
    },
    git: new GitCliRepository(new BunProcessRunner()),
    files: { kind: kindOf, read: readText },
    folder: folderAt,
    previewSetup: (host, root) => previewSetup(options, host, root),
  });
}

/** `setup --commit` in the repository at `root`. */
export function setupCommitter(root: string): CommitSetup {
  return new CommitSetup(new GitCliRepository(new BunProcessRunner()), root);
}
