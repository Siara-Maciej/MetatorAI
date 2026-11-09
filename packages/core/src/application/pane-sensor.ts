import { MetatorError } from "../domain/errors.ts";
import { type PaneState, type PaneStateView, paneStateOf } from "../domain/host-manifest.ts";
import { stripAnsi, tailLines } from "../domain/layout.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock } from "../ports/index.ts";
import type { RunJournal } from "./drive.ts";
import type { HostManifestCatalog } from "./host-manifests.ts";
import type { PtyBroker, PtyView } from "./pty-broker.ts";

export interface PaneSensorDependencies {
  readonly broker: Pick<PtyBroker, "status" | "list" | "backlog">;
  readonly manifests: Pick<HostManifestCatalog, "get">;
  readonly journal: Pick<RunJournal, "questions">;
  readonly clock: Clock;
}

export interface SensedPane extends PtyView {
  readonly state: PaneState;
  readonly reason: string;
}

/**
 * The pane sensor (R3, ADR-0080): what each live pane's agent is doing, read from the host's
 * manifest against the screen, the broker's timestamps (output, hook calls) and the run's open
 * questions. It asks the agent nothing and types nothing.
 */
export class PaneSensor {
  constructor(private readonly d: PaneSensorDependencies) {}

  async state(paneId: string): Promise<Result<PaneStateView, MetatorError>> {
    const live = this.d.broker.status(paneId);
    if (!live) return err(MetatorError.notFound(`a terminal in pane ${paneId}`));
    return this.sense(paneId, live);
  }

  /** Every live pane with its state, in the broker's order. */
  async all(): Promise<Result<readonly SensedPane[], MetatorError>> {
    const out: SensedPane[] = [];
    for (const live of this.d.broker.list()) {
      const sensed = await this.sense(live.paneId, live);
      if (sensed.isErr()) return err(sensed.error);
      out.push({ ...live, ...sensed.value });
    }
    return ok(out);
  }

  private async sense(paneId: string, live: PtyView): Promise<Result<PaneStateView, MetatorError>> {
    const manifest = await this.d.manifests.get(live.host);
    if (manifest.isErr()) return err(manifest.error);
    let openQuestion = false;
    if (live.runId) {
      const questions = await this.d.journal.questions(live.runId);
      if (questions.isErr()) return err(questions.error);
      openQuestion = questions.value.some((q) => !q.answer);
    }
    return ok(
      paneStateOf({
        alive: live.alive,
        ...(live.exitCode !== undefined ? { exitCode: live.exitCode } : {}),
        screen: tailLines(stripAnsi(this.d.broker.backlog(paneId)), manifest.value.screen.lines * 2),
        manifest: manifest.value,
        now: this.d.clock.now(),
        lastOutputAt: new Date(live.lastOutputAt),
        ...(live.lastHookAt ? { lastHookAt: new Date(live.lastHookAt) } : {}),
        openQuestion,
      }),
    );
  }
}
