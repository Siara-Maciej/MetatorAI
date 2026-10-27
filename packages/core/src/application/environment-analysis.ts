import {
  buildProfile,
  type EnvProfile,
  EnvProfileDocument,
  type MeasuredStart,
} from "../domain/environment-profile.ts";
import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { serializeJsonDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem } from "../ports/index.ts";
import type { EnvironmentCatalog, EnvironmentServices, ServiceReport } from "./environments.ts";
import type { MetatorPaths } from "./paths.ts";
import type { CreateWorktree, RemoveWorktree, WorktreeRegistry } from "./worktrees.ts";

const COLD = "analyze-cold";
const WARM = "analyze-warm";

/**
 * `env analyze` (F8.7, ADR-0055): starts the application in a new worktree, then in a second one,
 * measures every phase, removes both and writes the profile with its recommendations. Shared
 * services it started are stopped again; with `cold`, running shared services are restarted first
 * so their start is measured too.
 */
export class AnalyzeEnvironment {
  constructor(
    private readonly catalog: EnvironmentCatalog,
    private readonly registry: WorktreeRegistry,
    private readonly create: Pick<CreateWorktree, "execute">,
    private readonly remove: Pick<RemoveWorktree, "execute">,
    private readonly services: Pick<EnvironmentServices, "up" | "down" | "status" | "dropData">,
    private readonly fs: FileSystem,
    private readonly clock: Clock,
    private readonly paths: MetatorPaths,
  ) {}

  async execute(input: { readonly cold: boolean }): Promise<Result<EnvProfile, MetatorError>> {
    const env = await this.catalog.load();
    if (env.isErr()) return err(env.error);
    const before = await this.services.status({});
    if (before.isErr()) return err(before.error);
    const sharedUp = before.value
      .filter((s) => s.scope === "shared" && s.status === "running")
      .map((s) => s.service);
    const shared = Object.keys(env.value.services).filter((id) => env.value.services[id]?.scope === "shared");
    for (const id of [COLD, WARM]) await this.discard(id);
    if (input.cold && sharedUp.length > 0) {
      const down = await this.services.down({ services: sharedUp, shared: true });
      if (down.isErr()) return err(down.error);
    }
    try {
      const cold = await this.measure(COLD);
      if (cold.isErr()) return err(cold.error);
      const warm = await this.measure(WARM);
      if (warm.isErr()) return err(warm.error);
      const profile = buildProfile(env.value, cold.value, warm.value, this.clock.now());
      const saved = await this.fs.write(
        this.paths.envProfile,
        serializeJsonDocument(EnvProfileDocument.stamp(profile)),
      );
      if (saved.isErr()) return err(saved.error);
      return ok(profile);
    } finally {
      for (const id of [COLD, WARM]) await this.discard(id);
      // Shared services that ran before keep running; the ones the analysis started stop again.
      const started = shared.filter((id) => !sharedUp.includes(id));
      if (started.length > 0) await this.services.down({ services: started, shared: true });
    }
  }

  private async measure(id: string): Promise<Result<MeasuredStart, MetatorError>> {
    const wt = await this.create.execute({ id });
    if (wt.isErr()) return err(wt.error);
    const t0 = this.clock.now().getTime();
    const up = await this.services.up({ worktree: id });
    if (up.isErr()) return err(up.error);
    return ok({
      worktree: id,
      ms: this.clock.now().getTime() - t0,
      services: Object.fromEntries(up.value.map((r) => [r.service, measured(r)])),
    });
  }

  /** Stops, drops and removes a worktree of an earlier or this analysis; a missing one is fine. */
  private async discard(id: string): Promise<void> {
    if ((await this.registry.get(id)).isErr()) return;
    await this.services.down({ worktree: id });
    await this.services.dropData({ worktree: id });
    await this.remove.execute({ id, force: true });
  }
}

function measured(r: ServiceReport): MeasuredStart["services"][string] {
  return {
    scope: r.scope as MeasuredStart["services"][string]["scope"],
    status: r.status === "running" ? "running" : "measured",
    phases: [...(r.phases ?? [])],
    ms: r.ms ?? 0,
  };
}
