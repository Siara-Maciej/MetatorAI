import { MetatorError } from "../domain/errors.ts";
import { type PaneState, type PaneStateView, paneStateOf } from "../domain/host-manifest.ts";
import { stripAnsi, tailLines } from "../domain/layout.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Clock } from "../ports/index.ts";
import type { HostManifestCatalog } from "./host-manifests.ts";
import type { LayoutStore } from "./layout-store.ts";
import type { PtyBroker, PtyView } from "./pty-broker.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";

/** How many lines from the bottom of a pane's screen are read: a host's dialog fits in them. */
const SCREEN_LINES = 60;

export interface PaneSensorDependencies {
  readonly broker: Pick<PtyBroker, "status" | "list" | "backlog"> & Partial<Pick<PtyBroker, "screen">>;
  readonly manifests: Pick<HostManifestCatalog, "get">;
  readonly journal: Pick<RunJournal, "questions">;
  readonly clock: Clock;
  /** Who a pane is in its run (a worker, the conductor): its questions are its own. */
  readonly identity?: PaneIdentity;
}

/** A pane as its run knows it: its role, the agent in it (a worker's name, the conductor's agent), its stage. */
export interface PaneWho {
  readonly role: string;
  readonly agent: string;
  readonly stage?: string;
}

export interface PaneIdentity {
  of(paneId: string): Promise<PaneWho | undefined>;
}

/**
 * A question is a pane's when it is the pane's agent's own; the conductor also takes the ones of
 * nobody in particular (a gate). A worker's question never makes the conductor wait.
 */
export function asksIn(q: { readonly agent?: string | undefined }, who: PaneWho | undefined): boolean {
  if (!who) return true;
  if (q.agent === who.agent) return true;
  return who.role === "conductor" && q.agent === undefined;
}

export interface SensedPane extends PtyView {
  readonly state: PaneState;
  readonly reason: string;
  /** A blocked pane's numbered choices (a host's menu), when its prompt has them. */
  readonly menu?: PaneStateView["menu"];
  /** The whole command its host's prompt asks to run, when it shows one. */
  readonly command?: string;
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
      const who = await this.d.identity?.of(paneId);
      openQuestion = questions.value.some((q) => !q.answer && asksIn(q, who));
    }
    return ok(
      paneStateOf({
        alive: live.alive,
        ...(live.exitCode !== undefined ? { exitCode: live.exitCode } : {}),
        // The screen as a person sees it: a host's dialog is read from it whole, and its
        // reason is that dialog in words, never the frames and escapes the host drew it with.
        screen: tailLines(
          (await this.d.broker.screen?.(paneId)) ?? stripAnsi(this.d.broker.backlog(paneId)),
          SCREEN_LINES,
        ),
        manifest: manifest.value,
        now: this.d.clock.now(),
        lastOutputAt: new Date(live.lastOutputAt),
        ...(live.lastHookAt ? { lastHookAt: new Date(live.lastHookAt) } : {}),
        openQuestion,
      }),
    );
  }
}

/** Who a pane is, read from the layout: a worker by its name and stage, any other by its label at the run's stage. */
export class LayoutPaneIdentity implements PaneIdentity {
  constructor(
    private readonly layout: Pick<LayoutStore, "load">,
    private readonly repo: Pick<RunRepository, "load">,
  ) {}

  async of(paneId: string): Promise<PaneWho | undefined> {
    const layout = await this.layout.load();
    if (layout.isErr()) return undefined;
    const pane = layout.value.panes.find((p) => p.id === paneId);
    if (!pane) return undefined;
    const record = !pane.worker && pane.runId ? await this.repo.load(pane.runId) : undefined;
    const stage = pane.worker?.stage ?? (record?.isOk() ? record.value.state.stage : undefined);
    return { role: pane.role, agent: pane.worker?.name ?? pane.label, ...(stage ? { stage } : {}) };
  }
}
