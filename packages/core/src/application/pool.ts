import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { WorktreeEntry } from "../domain/worktree.ts";
import type { EnvironmentServices, ServiceReport } from "./environments.ts";
import {
  type CreateWorktree,
  isFreePoolEntry,
  POOL_PREFIX,
  type RemoveWorktree,
  type WorktreeRegistry,
} from "./worktrees.ts";

export interface PoolEntry {
  readonly id: string;
  readonly path: string;
  readonly ports: WorktreeEntry["ports"];
  /** The run that took it; free when absent. */
  readonly run?: string;
}

export interface PoolReport {
  readonly free: readonly PoolEntry[];
  readonly taken: readonly PoolEntry[];
  /** Worktrees started by this call, with what their start took. */
  readonly started: readonly { readonly id: string; readonly services: readonly ServiceReport[] }[];
  readonly removed: readonly string[];
}

/**
 * `env pool` (F8.7, ADR-0055): worktrees on HEAD with their services already up, so a new run
 * starts in seconds. `run init --worktree` takes a free one; `fill` tops the pool up again.
 */
export class WarmPool {
  constructor(
    private readonly registry: WorktreeRegistry,
    private readonly create: Pick<CreateWorktree, "execute">,
    private readonly remove: Pick<RemoveWorktree, "execute">,
    private readonly services: Pick<EnvironmentServices, "up" | "down" | "dropData">,
  ) {}

  async fill(size: number): Promise<Result<PoolReport, MetatorError>> {
    const all = await this.registry.all();
    if (all.isErr()) return err(all.error);
    const ids = new Set(all.value.map((e) => e.id));
    let free = all.value.filter(isFreePoolEntry).length;
    const started: { id: string; services: readonly ServiceReport[] }[] = [];
    for (let n = 1; free < size; n++) {
      const id = `${POOL_PREFIX}${n}`;
      if (ids.has(id)) continue;
      const wt = await this.create.execute({ id });
      if (wt.isErr()) return err(wt.error);
      const up = await this.services.up({ worktree: id });
      if (up.isErr()) return err(up.error);
      started.push({ id, services: up.value });
      free++;
    }
    return this.report(started, []);
  }

  /** Stops and removes the free pool worktrees; taken ones belong to their runs. */
  async drain(): Promise<Result<PoolReport, MetatorError>> {
    const all = await this.registry.all();
    if (all.isErr()) return err(all.error);
    const removed: string[] = [];
    for (const e of all.value.filter(isFreePoolEntry)) {
      const down = await this.services.down({ worktree: e.id });
      if (down.isErr()) return err(down.error);
      const dropped = await this.services.dropData({ worktree: e.id });
      if (dropped.isErr()) return err(dropped.error);
      const r = await this.remove.execute({ id: e.id, force: true });
      if (r.isErr()) return err(r.error);
      removed.push(e.id);
    }
    return this.report([], removed);
  }

  async list(): Promise<Result<PoolReport, MetatorError>> {
    return this.report([], []);
  }

  private async report(
    started: PoolReport["started"],
    removed: readonly string[],
  ): Promise<Result<PoolReport, MetatorError>> {
    const all = await this.registry.all();
    if (all.isErr()) return err(all.error);
    const pool = all.value
      .filter((e) => e.id.startsWith(POOL_PREFIX))
      .map((e) => ({ id: e.id, path: e.path, ports: e.ports, ...(e.run ? { run: e.run } : {}) }));
    return ok({
      free: pool.filter((e) => e.run === undefined),
      taken: pool.filter((e) => e.run !== undefined),
      started,
      removed,
    });
  }
}
