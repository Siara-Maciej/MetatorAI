import { describe, expect, test } from "bun:test";
import type { HostDescriptor } from "../src/application/host-descriptors.ts";
import {
  CommitSetup,
  commitPaths,
  type InspectDependencies,
  InspectFolder,
} from "../src/application/inspect-folder.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import type { RepositoryGit } from "../src/ports/index.ts";

const help = (id: string) => ({
  install: { url: `https://${id}.example`, command: `npm i -g ${id}` },
  login: `${id} /login`,
  credentials: { env: [`${id.toUpperCase()}_TOKEN`], files: [{ path: `.${id}/login.json` }] },
});
const HOSTS: HostDescriptor[] = [
  { id: "claude", program: { env: "METATOR_CLAUDE_BIN", default: "claude" }, setup: help("claude") },
  { id: "copilot", program: { env: "METATOR_COPILOT_BIN", default: "copilot" }, setup: help("copilot") },
  // A host setup does not generate for, and the scenario host: not offered.
  { id: "opencode", program: { env: "METATOR_OPENCODE_BIN", default: "opencode" }, setup: help("opencode") },
  { id: "scenario" },
];

interface World {
  dirs?: string[];
  files?: Record<string, string>;
  /** Checkouts by folder: [top, main]. */
  checkouts?: Record<string, [string, string]>;
  uncommitted?: Record<string, string[]>;
  git?: boolean;
  onPath?: string[];
  env?: Record<string, string>;
  home?: Record<string, string>;
  folder?: { file: string | null; roots: string[] } | null;
  previewFails?: boolean;
  inContainer?: boolean;
  hosts?: HostDescriptor[];
}

function inspect(w: World = {}) {
  const previews: string[] = [];
  const git: RepositoryGit = {
    version: async () => (w.git === false ? undefined : "2.43.0"),
    checkout: async (dir) => {
      const c = w.checkouts?.[dir];
      return c ? { top: c[0], main: c[1] } : undefined;
    },
    uncommitted: async (root) => ok(w.uncommitted?.[root] ?? []),
    commit: async () => ok("sha"),
  };
  const d: InspectDependencies = {
    ...(w.inContainer ? { inContainer: true } : {}),
    version: "1.2.3",
    configVersion: 1,
    installLock: "metator/install.lock.json",
    hostOrder: ["copilot", "claude", "opencode"],
    hosts: w.hosts ?? HOSTS,
    installed: (programs) => programs.filter((p) => (w.onPath ?? []).includes(p)),
    env: w.env ?? {},
    readHome: (p) => (w.home?.[p] === undefined ? undefined : { json: JSON.parse(w.home[p] as string) }),
    git,
    files: {
      kind: (p) => (w.files?.[p] !== undefined ? "file" : (w.dirs ?? []).includes(p) ? "dir" : undefined),
      read: (p) => w.files?.[p],
    },
    folder: () => ok(w.folder ?? null),
    previewSetup: async (host, root) => {
      previews.push(root === undefined ? host : `${host}@${root}`);
      return w.previewFails
        ? err(new MetatorError("COMMAND_FAILED", "no canon"))
        : ok([`${host}/b.md`, `${host}/a.md`, "metator.config.yml"]);
    },
  };
  return { use: new InspectFolder(d), previews };
}

const SET_UP = {
  "/shop/metator.config.yml": "kind: MetatorConfig\nschemaVersion: 1\n",
  "/shop/metator/install.lock.json": "{}",
};

describe("InspectFolder", () => {
  test("a repository not set up: what setup writes for each host, sorted; the default host is the first installed in the order", async () => {
    const { use, previews } = inspect({
      dirs: ["/shop"],
      checkouts: { "/shop": ["/shop", "/shop"] },
      uncommitted: { "/shop": ["README.md"] },
      onPath: ["claude"],
      home: { ".claude/login.json": "{}" },
    });
    const i = (await use.execute({ path: "/shop" }))._unsafeUnwrap();
    expect([i.kind, i.next, i.version]).toEqual(["repo", "setup", "1.2.3"]);
    expect(i.repository).toEqual({
      root: "/shop",
      name: "shop",
      worktree: false,
      setUp: "no",
      config: null,
      uncommitted: ["README.md"],
    });
    expect(i.git).toEqual({
      installed: true,
      version: "2.43.0",
      install: { url: "https://git-scm.com/downloads" },
    });
    // Previewed against the repository itself: a .gitignore that ignores .metator/ is not written again.
    expect(previews).toEqual(["copilot@/shop", "claude@/shop"]);
    expect(i.writes).toEqual({
      copilot: ["copilot/a.md", "copilot/b.md", "metator.config.yml"],
      claude: ["claude/a.md", "claude/b.md", "metator.config.yml"],
    });
    expect(i.hosts.map((h) => [h.id, h.installed, h.loggedIn])).toEqual([
      ["copilot", false, null],
      ["claude", true, true],
    ]);
    expect(i.hosts[1]).toMatchObject({
      program: "claude",
      login: "claude /login",
      install: help("claude").install,
    });
    expect(i.defaultHost).toBe("claude");
  });

  test("in a dev container each host and git say how to add them there", async () => {
    const hosts: HostDescriptor[] = HOSTS.map((h) =>
      h.id === "claude" && h.setup
        ? { ...h, setup: { ...h.setup, container: { feature: "f", command: "c" } } }
        : h,
    );
    const base = { dirs: ["/x"], onPath: ["claude"], hosts };
    const there = inspect({ ...base, inContainer: true });
    const outside = inspect(base);
    const inside = (await there.use.execute({ path: "/x" }))._unsafeUnwrap();
    expect(inside.hosts.map((h) => [h.id, h.fix])).toEqual([
      ["copilot", undefined],
      ["claude", { feature: "f", command: "c" }],
    ]);
    expect(inside.git.fix).toEqual({
      feature: '"ghcr.io/devcontainers/features/git:1": {}',
      command: "sudo apt-get update && sudo apt-get install -y git",
    });
    const here = (await outside.use.execute({ path: "/x" }))._unsafeUnwrap();
    expect([here.hosts.some((h) => "fix" in h), "fix" in here.git]).toEqual([false, false]);
  });

  test("installed but no sign of a login is false; a token in the environment counts", async () => {
    const base = { dirs: ["/x"], onPath: ["claude", "copilot"] };
    const none = (await inspect(base).use.execute({ path: "/x" }))._unsafeUnwrap();
    expect(none.hosts.map((h) => h.loggedIn)).toEqual([false, false]);
    expect(none.defaultHost).toBe("copilot");
    const token = (
      await inspect({ ...base, env: { COPILOT_TOKEN: "t" } }).use.execute({ path: "/x" })
    )._unsafeUnwrap();
    expect(token.hosts.map((h) => h.loggedIn)).toEqual([true, false]);
  });

  test("a set up repository is added as it is: nothing to preview", async () => {
    const { use, previews } = inspect({
      dirs: ["/shop"],
      files: SET_UP,
      checkouts: { "/shop": ["/shop", "/shop"] },
    });
    const i = (await use.execute({ path: "/shop" }))._unsafeUnwrap();
    expect([i.next, i.repository?.setUp, i.repository?.config, i.writes]).toEqual([
      "add",
      "yes",
      "metator.config.yml",
      {},
    ]);
    expect(previews).toEqual([]);
  });

  test("a config written by a newer MetatorAI says update the app, and nothing is previewed", async () => {
    const { use, previews } = inspect({
      dirs: ["/shop"],
      files: { ...SET_UP, "/shop/metator.config.yml": "kind: MetatorConfig\nschemaVersion: 9\n" },
      checkouts: { "/shop": ["/shop", "/shop"] },
    });
    const i = (await use.execute({ path: "/shop" }))._unsafeUnwrap();
    expect([i.next, i.repository?.setUp]).toEqual(["update-app", "newer"]);
    expect(previews).toEqual([]);
  });

  test("a sub-folder or a linked worktree counts as its repository: the main checkout is what is added", async () => {
    const { use } = inspect({
      dirs: ["/wt/shop-fix"],
      files: { "/shop/metator.config.yml": "schemaVersion: 1\n", "/shop/metator/install.lock.json": "{}" },
      checkouts: { "/wt/shop-fix": ["/wt/shop-fix", "/shop"] },
    });
    const i = (await use.execute({ path: "/wt/shop-fix" }))._unsafeUnwrap();
    expect([i.repository?.root, i.repository?.name, i.repository?.worktree, i.next]).toEqual([
      "/shop",
      "shop",
      true,
      "add",
    ]);
  });

  test("a folder of repositories: each one's state; setup per repository while one is not set up", async () => {
    const { use, previews } = inspect({
      dirs: ["/work"],
      files: {
        "/work/a/metator.config.yml": "schemaVersion: 1\n",
        "/work/a/metator/install.lock.json": "{}",
      },
      checkouts: { "/work/a": ["/work/a", "/work/a"], "/work/b": ["/work/b", "/work/b"] },
      folder: { file: "/work/metator.repos.yml", roots: ["/work/a", "/work/b"] },
    });
    const i = (await use.execute({ path: "/work" }))._unsafeUnwrap();
    expect([i.kind, i.next, i.repository, i.folder?.file]).toEqual([
      "folder",
      "setup-repos",
      null,
      "/work/metator.repos.yml",
    ]);
    expect(i.folder?.repos.map((r) => [r.name, r.setUp])).toEqual([
      ["a", "yes"],
      ["b", "no"],
    ]);
    expect(Object.keys(i.writes)).toEqual(["copilot", "claude"]);
    // A folder's repositories differ: the preview is of a repository with nothing in it yet.
    expect(previews).toEqual(["copilot", "claude"]);
  });

  test("not a repository, nothing there, git not installed", async () => {
    expect(
      (await inspect({ dirs: ["/plain"] }).use.execute({ path: "/plain" }))._unsafeUnwrap(),
    ).toMatchObject({
      kind: "not-git",
      next: "git-init",
      repository: null,
      folder: null,
      writes: {},
    });
    expect((await inspect().use.execute({ path: "/gone" }))._unsafeUnwrap()).toMatchObject({
      kind: "missing",
      next: "choose-another",
    });
    expect(
      (await inspect({ files: { "/a-file": "x" } }).use.execute({ path: "/a-file" }))._unsafeUnwrap().kind,
    ).toBe("missing");
    const noGit = (
      await inspect({ dirs: ["/shop"], git: false }).use.execute({ path: "/shop" })
    )._unsafeUnwrap();
    expect([noGit.next, noGit.git.installed, noGit.git.version]).toEqual(["install-git", false, null]);
    expect((await inspect({ git: false }).use.execute({ path: "/gone" }))._unsafeUnwrap().next).toBe(
      "choose-another",
    );
  });

  test("a preview that fails is the inspection's error", async () => {
    const r = await inspect({
      dirs: ["/shop"],
      checkouts: { "/shop": ["/shop", "/shop"] },
      previewFails: true,
    }).use.execute({
      path: "/shop",
    });
    expect(r._unsafeUnwrapErr().message).toBe("no canon");
  });
});

describe("CommitSetup", () => {
  test("the files named, once and sorted, in one commit with the setup's message", async () => {
    const calls: unknown[] = [];
    const use = new CommitSetup(
      {
        commit: async (root, files, message) => {
          calls.push([root, files, message]);
          return ok("abc123");
        },
      },
      "/shop",
    );
    const done = (await use.execute({ files: ["b.md", "a.md", "b.md"] }))._unsafeUnwrap();
    expect(done).toEqual({ commit: "abc123", files: ["a.md", "b.md"] });
    expect(calls).toEqual([["/shop", ["a.md", "b.md"], "Set up MetatorAI"]]);
  });

  test("nothing, a path outside the repository or MetatorAI's own state is refused before git runs", () => {
    expect(commitPaths([])._unsafeUnwrapErr().code).toBe("USAGE");
    for (const bad of ["/etc/passwd", "../x", "a/../../x", "C:\\x", ".metator/daemon.json", ".metator", " "])
      expect(commitPaths(["ok.md", bad])._unsafeUnwrapErr().message).toContain("not a file setup writes");
    expect(commitPaths([".metatorrc", "docs/.metator.md"])._unsafeUnwrap()).toEqual([
      ".metatorrc",
      "docs/.metator.md",
    ]);
  });

  test("git's refusal is the command's error", async () => {
    const use = new CommitSetup(
      { commit: async () => err(new MetatorError("COMMAND_FAILED", "git commit failed")) },
      "/r",
    );
    expect((await use.execute({ files: ["a"] }))._unsafeUnwrapErr().message).toBe("git commit failed");
  });
});
