import { MetatorError } from "../domain/errors.ts";
import { InProcessLock } from "../domain/in-process-lock.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  candidateBlocks,
  DEFAULT_PORT_COUNT,
  type PortBlock,
  type PortLease,
  PortLeasesDocument,
  pruneCandidates,
  WORKTREE_ID,
  type WorktreeEntry,
  WorktreeRegistryDocument,
} from "../domain/worktree.ts";
import type {
  Clock,
  FileLock,
  FileSystem,
  MachineState,
  PortProbe,
  WorktreeManager,
} from "../ports/index.ts";
import { parseDocumentText, readDocument, writeDocument } from "./document-io.ts";
import type { MetatorPaths } from "./paths.ts";
import type { RunRepository } from "./run-repository.ts";

/** Where `metator setup` writes: the configuration, the canon, host agents, skills and instructions. */
export const SETUP_PATHS = [
  "metator.config.yml",
  "metator",
  "docs/metator",
  ".claude/agents",
  ".claude/skills",
  ".claude/settings.json",
  ".github/metator",
  ".github/agents",
  ".github/skills",
  ".github/instructions",
  ".github/hooks",
] as const;

/** The registry file (`.metator/worktrees.json`): every worktree MetatorAI created and its ports. */
export class WorktreeRegistry {
  constructor(
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
    /** One writer at a time; the runtime gives the lock that holds across processes. */
    private readonly lock: FileLock = new InProcessLock(),
  ) {}

  /**
   * Runs `work` while nobody else changes the registry: what reads it, decides and writes it back
   * (a new worktree and its ports) does all three inside. `work` uses `all` and `save`, never
   * `exclusive` or `update` again.
   */
  exclusive<T>(work: () => Promise<Result<T, MetatorError>>): Promise<Result<T, MetatorError>> {
    return this.lock.hold(this.paths.worktreeRegistry, work);
  }

  /** Changes the registry as it is now, in one step (R4). */
  update(
    change: (entries: readonly WorktreeEntry[]) => readonly WorktreeEntry[],
  ): Promise<Result<void, MetatorError>> {
    return this.exclusive(async () => {
      const all = await this.all();
      if (all.isErr()) return err(all.error);
      return this.save(change(all.value));
    });
  }

  async all(): Promise<Result<readonly WorktreeEntry[], MetatorError>> {
    const doc = await readDocument(this.fs, this.paths.worktreeRegistry, WorktreeRegistryDocument);
    return doc.map((d) => d?.worktrees ?? []);
  }

  async get(id: string): Promise<Result<WorktreeEntry, MetatorError>> {
    const all = await this.all();
    if (all.isErr()) return err(all.error);
    const entry = all.value.find((e) => e.id === id);
    return entry
      ? ok(entry)
      : err(
          new MetatorError("NOT_FOUND", `no worktree ${id}`, {
            hint: "`metator worktree list` shows the worktrees MetatorAI created.",
          }),
        );
  }

  /** Writes the whole registry: inside `exclusive` only, with entries read there. */
  async save(entries: readonly WorktreeEntry[]): Promise<Result<void, MetatorError>> {
    const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
    return writeDocument(
      this.fs,
      this.paths.worktreeRegistry,
      WorktreeRegistryDocument,
      { worktrees: sorted },
      "json",
    );
  }
}

const LEASES = "port-leases.json";

/**
 * The port blocks every repository on this machine holds (G1, ADR-0056). Leases whose worktree
 * directory is gone hold nothing, so a deleted repository never blocks ports for long.
 */
export class MachineLeases {
  constructor(
    private readonly state: MachineState,
    /** Absolute path of this repository. */
    private readonly repo: string,
  ) {}

  /** Live leases of every repository. */
  async all(): Promise<Result<readonly PortLease[], MetatorError>> {
    const text = await this.state.read(LEASES);
    if (text.isErr()) return err(text.error);
    if (text.value === undefined) return ok([]);
    const doc = parseDocumentText(text.value, LEASES, PortLeasesDocument, "json");
    if (doc.isErr()) return err(doc.error);
    const live: PortLease[] = [];
    for (const l of doc.value.leases) if (await this.state.dirExists(l.path)) live.push(l);
    return ok(live);
  }

  /**
   * Runs `work` while no process of any repository changes the leases: picking a free block and
   * writing its lease happen inside, so two repositories never get the same ports (R4). `work`
   * uses `all` and `put`, never `add` or `remove`.
   */
  exclusive<T>(work: () => Promise<Result<T, MetatorError>>): Promise<Result<T, MetatorError>> {
    return this.state.locked(LEASES, work);
  }

  async add(entry: WorktreeEntry, root: string): Promise<Result<void, MetatorError>> {
    return this.exclusive(() => this.put(entry, root));
  }

  /** Writes a worktree's lease: inside `exclusive` only. */
  async put(entry: WorktreeEntry, root: string): Promise<Result<void, MetatorError>> {
    return this.rewrite((leases) => [
      ...leases.filter((l) => !(l.repo === this.repo && l.worktree === entry.id)),
      {
        repo: this.repo,
        worktree: entry.id,
        path: `${root}/${entry.path}`,
        ports: entry.ports,
        at: entry.createdAt,
      },
    ]);
  }

  async remove(worktree: string): Promise<Result<void, MetatorError>> {
    return this.exclusive(() =>
      this.rewrite((leases) => leases.filter((l) => !(l.repo === this.repo && l.worktree === worktree))),
    );
  }

  /** Rewrites the file with live leases only, so stale ones are dropped as a side effect. */
  private async rewrite(
    change: (leases: readonly PortLease[]) => readonly PortLease[],
  ): Promise<Result<void, MetatorError>> {
    const live = await this.all();
    if (live.isErr()) return err(live.error);
    return writeDocument(this.state, LEASES, PortLeasesDocument, { leases: [...change(live.value)] }, "json");
  }
}

export interface CreateWorktreeInput {
  readonly id: string;
  /** The ref to branch from (default HEAD). */
  readonly base?: string;
  readonly run?: string;
  /** How many ports the worktree leases (default 20). */
  readonly ports?: number;
}

/** `worktree new`: a git worktree on its own branch, with a block of ports no other worktree holds. */
export class CreateWorktree {
  constructor(
    private readonly registry: WorktreeRegistry,
    private readonly git: WorktreeManager,
    private readonly probe: PortProbe,
    private readonly clock: Clock,
    private readonly paths: MetatorPaths,
    /** Blocks other repositories on this machine hold, and the absolute root of this one. */
    private readonly machine: { readonly leases: MachineLeases; readonly root: string },
  ) {}

  async execute(input: CreateWorktreeInput): Promise<Result<WorktreeEntry, MetatorError>> {
    if (!WORKTREE_ID.test(input.id)) {
      return err(
        MetatorError.usage(`invalid worktree id "${input.id}"`, "Use lowercase letters, digits and -."),
      );
    }
    // From reading who holds which ports to writing this worktree's block, nobody else changes
    // the registry or the machine's leases: worktrees made at the same time get different ports
    // and every one of them is in the registry (R4).
    return this.registry.exclusive(() => this.machine.leases.exclusive(() => this.create(input)));
  }

  private async create(input: CreateWorktreeInput): Promise<Result<WorktreeEntry, MetatorError>> {
    const all = await this.registry.all();
    if (all.isErr()) return err(all.error);
    if (all.value.some((e) => e.id === input.id)) {
      return err(
        MetatorError.usage(`worktree ${input.id} already exists`, "Pick another id or remove it first."),
      );
    }
    const others = await this.machine.leases.all();
    if (others.isErr()) return err(others.error);
    const ports = await this.lease(
      [...all.value.map((e) => e.ports), ...others.value.map((l) => l.ports)],
      input.ports ?? DEFAULT_PORT_COUNT,
    );
    if (ports.isErr()) return err(ports.error);

    const entry: WorktreeEntry = {
      id: input.id,
      path: `${this.paths.worktrees}/${input.id}`,
      branch: `metator/${input.id}`,
      base: input.base ?? "HEAD",
      ...(input.run ? { run: input.run } : {}),
      ports: ports.value,
      createdAt: this.clock.now().toISOString(),
    };
    // The run's state stays in this checkout; its agents, hooks and plan commands find it in the
    // worktree at the same path.
    // A setup not committed yet (`metator setup` just ran) still reaches the worktree: without it
    // the run's gates, agents and skills would be the defaults.
    const added = await this.git.add(entry.path, entry.branch, entry.base, [this.paths.runs], SETUP_PATHS);
    if (added.isErr()) return err(added.error);
    const saved = await this.registry.save([...all.value, entry]);
    if (saved.isErr()) return err(saved.error);
    const leased = await this.machine.leases.put(entry, this.machine.root);
    if (leased.isErr()) return err(leased.error);
    return ok(entry);
  }

  /** The first block that no worktree leases and whose every port is free on this machine. */
  private async lease(leased: readonly PortBlock[], count: number): Promise<Result<PortBlock, MetatorError>> {
    for (const block of candidateBlocks(leased, count)) {
      let free = true;
      for (let p = block.from; p < block.from + block.count && free; p++) free = await this.probe.isFree(p);
      if (free) return ok(block);
    }
    return err(
      new MetatorError("NOT_FOUND", `no free block of ${count} ports`, {
        hint: "Remove finished worktrees (`metator worktree prune`) or lease fewer ports (--ports).",
      }),
    );
  }
}

/** Worktrees of the warm pool (`env pool`, F8.7) are named pool-<n>; a free one has no run. */
export const POOL_PREFIX = "pool-";
export const isFreePoolEntry = (e: WorktreeEntry) => e.id.startsWith(POOL_PREFIX) && e.run === undefined;

/**
 * The worktree for a new run: a free warm pool worktree when there is one (its services already
 * run; it moves to the run's branch), else a new one (F8.7, ADR-0055).
 */
export class ProvideWorktree {
  constructor(
    private readonly registry: WorktreeRegistry,
    private readonly git: WorktreeManager,
    private readonly create: Pick<CreateWorktree, "execute">,
  ) {}

  async execute(input: CreateWorktreeInput): Promise<Result<WorktreeEntry, MetatorError>> {
    const run = input.run;
    if (!run) return this.create.execute(input);
    // Two runs starting at once never take the same pool worktree.
    const fromPool = await this.registry.exclusive<WorktreeEntry | undefined>(async () => {
      const all = await this.registry.all();
      if (all.isErr()) return err(all.error);
      const free = all.value.find(isFreePoolEntry);
      if (!free) return ok(undefined);
      const branch = `metator/${input.id}`;
      const base = input.base ?? "HEAD";
      const switched = await this.git.switchBranch(free.path, branch, base);
      if (switched.isErr()) return err(switched.error);
      const taken: WorktreeEntry = { ...free, branch, base, run };
      const saved = await this.registry.save(all.value.map((e) => (e.id === free.id ? taken : e)));
      return saved.map(() => taken);
    });
    if (fromPool.isErr()) return err(fromPool.error);
    return fromPool.value ? ok(fromPool.value) : this.create.execute(input);
  }
}

export interface WorktreeView extends WorktreeEntry {
  readonly dirty: boolean;
  /** The run's status when the worktree belongs to a run that still exists. */
  readonly runStatus?: string;
}

/** `worktree list`: every worktree with its ports, its run and whether it has unsaved work. */
export class ListWorktrees {
  constructor(
    private readonly registry: WorktreeRegistry,
    private readonly git: WorktreeManager,
    private readonly runs: RunRepository,
  ) {}

  async execute(): Promise<Result<readonly WorktreeView[], MetatorError>> {
    const all = await this.registry.all();
    if (all.isErr()) return err(all.error);
    const out: WorktreeView[] = [];
    for (const e of all.value) {
      const dirty = await this.git.isDirty(e.path);
      if (dirty.isErr()) return err(dirty.error);
      const status = e.run ? await runStatus(this.runs, e.run) : undefined;
      out.push({ ...e, dirty: dirty.value, ...(status ? { runStatus: status } : {}) });
    }
    return ok(out);
  }
}

async function runStatus(runs: RunRepository, run: string): Promise<string | undefined> {
  if (!(await runs.exists(run))) return undefined;
  const record = await runs.load(run);
  return record.isOk() ? record.value.state.status : undefined;
}

/** `worktree rm`: removes the worktree and frees its ports; unsaved work needs --force. */
export class RemoveWorktree {
  constructor(
    private readonly registry: WorktreeRegistry,
    private readonly git: WorktreeManager,
    private readonly leases: MachineLeases,
  ) {}

  async execute(input: {
    readonly id: string;
    readonly force: boolean;
  }): Promise<Result<WorktreeEntry, MetatorError>> {
    const entry = await this.registry.get(input.id);
    if (entry.isErr()) return err(entry.error);
    const dirty = await this.git.isDirty(entry.value.path);
    if (dirty.isErr()) return err(dirty.error);
    if (dirty.value && !input.force) {
      return err(
        MetatorError.usage(
          `worktree ${input.id} has uncommitted changes`,
          `Commit or stash them in ${entry.value.path}, or pass --force to lose them.`,
        ),
      );
    }
    const removed = await this.git.remove(entry.value.path, input.force);
    if (removed.isErr()) return err(removed.error);
    const saved = await this.registry.update((all) => all.filter((e) => e.id !== input.id));
    if (saved.isErr()) return err(saved.error);
    const released = await this.leases.remove(input.id);
    if (released.isErr()) return err(released.error);
    return ok(entry.value);
  }
}

export interface PruneReport {
  readonly removed: readonly string[];
  /** Finished worktrees kept because they hold uncommitted work. */
  readonly keptDirty: readonly string[];
}

/** `worktree prune`: worktrees of finished runs older than N days; never one with unsaved work. */
export class PruneWorktrees {
  constructor(
    private readonly registry: WorktreeRegistry,
    private readonly remove: RemoveWorktree,
    private readonly git: WorktreeManager,
    private readonly runs: RunRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    readonly olderThanDays: number;
    readonly dryRun: boolean;
  }): Promise<Result<PruneReport, MetatorError>> {
    const all = await this.registry.all();
    if (all.isErr()) return err(all.error);
    const runStatusById = new Map<string, string>();
    for (const e of all.value) {
      const status = e.run ? await runStatus(this.runs, e.run) : undefined;
      if (e.run && status) runStatusById.set(e.run, status);
    }
    const candidates = pruneCandidates({
      entries: all.value,
      runStatus: runStatusById,
      now: this.clock.now(),
      olderThanDays: input.olderThanDays,
    });
    const removed: string[] = [];
    const keptDirty: string[] = [];
    for (const e of candidates) {
      const dirty = await this.git.isDirty(e.path);
      if (dirty.isErr()) return err(dirty.error);
      if (dirty.value) {
        keptDirty.push(e.id);
        continue;
      }
      if (!input.dryRun) {
        const r = await this.remove.execute({ id: e.id, force: false });
        if (r.isErr()) return err(r.error);
      }
      removed.push(e.id);
    }
    return ok({ removed, keptDirty });
  }
}
