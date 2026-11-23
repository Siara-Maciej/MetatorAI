import { CONFIG_FILES, HOST_TARGETS, type HostTarget } from "../domain/config.ts";
import { GIT_CONTAINER_FIX } from "../domain/devcontainer.ts";
import { MetatorError } from "../domain/errors.ts";
import {
  defaultHost,
  GIT_INSTALL,
  type HomeFile,
  type InspectedHost,
  type InspectedRepository,
  type Inspection,
  type InspectionKind,
  loginFound,
  nextStep,
  schemaVersionOf,
  setUpState,
} from "../domain/inspection.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseYamlDocument } from "../domain/versioned.ts";
import type { RepositoryGit } from "../ports/index.ts";
import type { HostDescriptor } from "./host-descriptors.ts";

/** A path below a folder; both separators work on every platform's file system calls. */
const below = (dir: string, path: string) => `${dir.replace(/[\\/]+$/, "")}/${path}`;
const lastPart = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? path;

export interface InspectDependencies {
  /** It runs in a dev container (ADR-0106): each host and git say how to add them there. */
  readonly inContainer?: boolean;
  /** This MetatorAI's version, and the newest config schema it reads. */
  readonly version: string;
  readonly configVersion: number;
  /** Where the install lock is in a repository (`paths.installLock`). */
  readonly installLock: string;
  /** The team's host order (`supervisor.hostOrder`): the default host is the first installed. */
  readonly hostOrder: readonly string[];
  readonly hosts: readonly HostDescriptor[];
  /** Which of these programs are on PATH. */
  readonly installed: (programs: readonly string[]) => readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** A host's file in the home folder (a path relative to it), or undefined when it is not there. */
  readonly readHome: (path: string) => HomeFile | undefined;
  readonly git: RepositoryGit;
  /** An absolute path: a folder, a file, or nothing; and a file's text. */
  readonly files: {
    readonly kind: (path: string) => "dir" | "file" | undefined;
    readonly read: (path: string) => string | undefined;
  };
  /**
   * The folder of repositories at exactly `path`: its `metator.repos.yml` (or null) and the
   * repositories' checkouts, absolute; null when `path` is no folder of repositories.
   */
  readonly folder: (
    path: string,
  ) => Result<{ readonly file: string | null; readonly roots: readonly string[] } | null, MetatorError>;
  /**
   * The files `setup --host <host>` writes in a repository not set up yet (a setup done in a scratch
   * folder); `root`: the repository's, whose own files (its `.gitignore`) the preview starts from.
   */
  readonly previewSetup: (
    host: HostTarget,
    root?: string,
  ) => Promise<Result<readonly string[], MetatorError>>;
}

/**
 * `metator inspect <path>` (ADR-0105): what a folder is to MetatorAI, read only. Same folder,
 * same machine, same answer: lists are sorted and nothing holds a time.
 */
export class InspectFolder {
  constructor(private readonly d: InspectDependencies) {}

  async execute(input: { readonly path: string }): Promise<Result<Inspection, MetatorError>> {
    const d = this.d;
    const path = input.path;
    const gitVersion = await d.git.version();
    const hosts = this.hosts();

    let kind: InspectionKind;
    let repository: InspectedRepository | null = null;
    let folder: Inspection["folder"] = null;
    if (d.files.kind(path) !== "dir") kind = "missing";
    else {
      const checkout = gitVersion === undefined ? undefined : await d.git.checkout(path);
      if (checkout) {
        const repo = await this.repository(checkout.main, checkout.top !== checkout.main);
        if (repo.isErr()) return err(repo.error);
        [kind, repository] = ["repo", repo.value];
      } else {
        const found = d.folder(path);
        if (found.isErr()) return err(found.error);
        if (found.value && found.value.roots.length > 0) {
          const repos: InspectedRepository[] = [];
          for (const root of found.value.roots) {
            const at = gitVersion === undefined ? undefined : await d.git.checkout(root);
            const repo = await this.repository(at?.main ?? root, at !== undefined && at.top !== at.main);
            if (repo.isErr()) return err(repo.error);
            repos.push(repo.value);
          }
          [kind, folder] = ["folder", { file: found.value.file, repos }];
        } else kind = "not-git";
      }
    }
    const repos = repository ? [repository] : (folder?.repos ?? []);

    const writes: Partial<Record<HostTarget, readonly string[]>> = {};
    if (repos.some((r) => r.setUp === "no"))
      for (const host of HOST_TARGETS) {
        const files = await d.previewSetup(host, repository?.root);
        if (files.isErr()) return err(files.error);
        writes[host] = [...files.value].sort();
      }

    return ok({
      path,
      kind,
      next: gitVersion === undefined && kind !== "missing" ? "install-git" : nextStep(kind, repos),
      git: {
        installed: gitVersion !== undefined,
        version: gitVersion ?? null,
        install: GIT_INSTALL,
        ...(d.inContainer ? { fix: GIT_CONTAINER_FIX } : {}),
      },
      repository,
      folder,
      hosts,
      defaultHost: defaultHost(d.hostOrder, hosts),
      writes,
      version: d.version,
    });
  }

  /** Every host setup can generate for, in the team's order, with whether it is installed and logged in. */
  private hosts(): InspectedHost[] {
    const d = this.d;
    const rank = (id: string) => {
      const i = d.hostOrder.indexOf(id);
      return i < 0 ? d.hostOrder.length : i;
    };
    const known = d.hosts.filter(
      (h): h is HostDescriptor & { id: HostTarget } =>
        (HOST_TARGETS as readonly string[]).includes(h.id) &&
        h.program !== undefined &&
        h.setup !== undefined,
    );
    const programs = known.map((h) => h.program?.default as string);
    const there = new Set(d.installed(programs));
    return known
      .map((h) => {
        const program = h.program?.default as string;
        const setup = h.setup as NonNullable<HostDescriptor["setup"]>;
        const installed = there.has(program);
        return {
          id: h.id,
          program,
          installed,
          loggedIn: installed ? loginFound(setup.credentials, d.env, d.readHome) : null,
          install: setup.install,
          login: setup.login,
          ...(d.inContainer && setup.container ? { fix: setup.container } : {}),
        };
      })
      .sort((a, b) => rank(a.id) - rank(b.id));
  }

  private async repository(
    root: string,
    worktree: boolean,
  ): Promise<Result<InspectedRepository, MetatorError>> {
    const d = this.d;
    let config: string | null = null;
    let version: number | undefined;
    for (const file of CONFIG_FILES) {
      const text = d.files.read(below(root, file));
      if (text === undefined) continue;
      config = file;
      const raw = parseYamlDocument(text, file);
      // A config that does not parse is not this MetatorAI's to judge: setup says what is wrong with it.
      version = raw.isOk() ? (schemaVersionOf(raw.value) ?? 0) : 0;
      break;
    }
    const lock = d.files.kind(below(root, d.installLock)) === "file";
    const uncommitted = await d.git.uncommitted(root);
    return ok({
      root,
      name: lastPart(root),
      worktree,
      setUp: setUpState(version, d.configVersion, lock),
      config,
      uncommitted: uncommitted.isOk() ? uncommitted.value : [],
    });
  }
}

/** What `setup --commit` takes: repository-relative paths, none outside the repository or in MetatorAI's state. */
export function commitPaths(files: readonly string[]): Result<readonly string[], MetatorError> {
  const bad = files.filter(
    (f) =>
      f.trim() === "" ||
      /^([\\/]|[A-Za-z]:)/.test(f) ||
      f.split(/[\\/]/).includes("..") ||
      /^\.metator([\\/]|$)/.test(f),
  );
  if (files.length === 0)
    return err(MetatorError.usage("nothing to commit: name the files setup wrote (--files)"));
  if (bad.length > 0)
    return err(
      MetatorError.usage(
        `not a file setup writes: ${bad.join(", ")}`,
        "Name repository-relative paths, as `setup` reports them in `written`.",
      ),
    );
  return ok([...new Set(files)].sort());
}

/**
 * `metator setup --commit --files <files…>` (ADR-0105): the files a setup wrote, and only those,
 * in one commit "Set up MetatorAI". A commit is always the person's decision: this runs when they
 * click Commit in the app or type the command, never on its own.
 */
export class CommitSetup {
  static readonly MESSAGE = "Set up MetatorAI";

  constructor(
    private readonly git: Pick<RepositoryGit, "commit">,
    private readonly root: string,
  ) {}

  async execute(input: {
    readonly files: readonly string[];
  }): Promise<Result<{ readonly commit: string; readonly files: readonly string[] }, MetatorError>> {
    const files = commitPaths(input.files);
    if (files.isErr()) return err(files.error);
    const commit = await this.git.commit(this.root, files.value, CommitSetup.MESSAGE);
    return commit.map((sha) => ({ commit: sha, files: files.value }));
  }
}
