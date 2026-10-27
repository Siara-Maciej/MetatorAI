import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import {
  candidateBlocks,
  DEFAULT_PORT_COUNT,
  type PortBlock,
  pruneCandidates,
  WORKTREE_ID,
  type WorktreeEntry,
  WorktreeRegistryDocument,
} from "../domain/worktree.ts";
import type { Clock, FileSystem, PortProbe, WorktreeManager } from "../ports/index.ts";
import type { MetatorPaths } from "./paths.ts";
import type { RunRepository } from "./run-repository.ts";

/** The registry file (`.metator/worktrees.json`): every worktree MetatorAI created and its ports. */
export class WorktreeRegistry {
  constructor(
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async all(): Promise<Result<readonly WorktreeEntry[], MetatorError>> {
    const file = this.paths.worktreeRegistry;
    if (!(await this.fs.exists(file))) return ok([]);
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    return parseJsonDocument(text.value, file)
      .andThen((raw) => WorktreeRegistryDocument.parse(raw, file))
      .map((doc) => doc.worktrees);
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

  async save(entries: readonly WorktreeEntry[]): Promise<Result<void, MetatorError>> {
    const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
    return this.fs.write(
      this.paths.worktreeRegistry,
      serializeJsonDocument(WorktreeRegistryDocument.stamp({ worktrees: sorted })),
    );
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
  ) {}

  async execute(input: CreateWorktreeInput): Promise<Result<WorktreeEntry, MetatorError>> {
    if (!WORKTREE_ID.test(input.id)) {
      return err(
        MetatorError.usage(`invalid worktree id "${input.id}"`, "Use lowercase letters, digits and -."),
      );
    }
    const all = await this.registry.all();
    if (all.isErr()) return err(all.error);
    if (all.value.some((e) => e.id === input.id)) {
      return err(
        MetatorError.usage(`worktree ${input.id} already exists`, "Pick another id or remove it first."),
      );
    }
    const ports = await this.lease(
      all.value.map((e) => e.ports),
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
    const added = await this.git.add(entry.path, entry.branch, entry.base);
    if (added.isErr()) return err(added.error);
    const saved = await this.registry.save([...all.value, entry]);
    if (saved.isErr()) return err(saved.error);
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
    const all = await this.registry.all();
    if (all.isErr()) return err(all.error);
    const free = all.value.find(isFreePoolEntry);
    if (!free || !input.run) return this.create.execute(input);
    const branch = `metator/${input.id}`;
    const base = input.base ?? "HEAD";
    const switched = await this.git.switchBranch(free.path, branch, base);
    if (switched.isErr()) return err(switched.error);
    const taken: WorktreeEntry = { ...free, branch, base, run: input.run };
    const saved = await this.registry.save(all.value.map((e) => (e.id === free.id ? taken : e)));
    if (saved.isErr()) return err(saved.error);
    return ok(taken);
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
    const all = await this.registry.all();
    if (all.isErr()) return err(all.error);
    const saved = await this.registry.save(all.value.filter((e) => e.id !== input.id));
    if (saved.isErr()) return err(saved.error);
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
