/**
 * What the sidebar's rows read from the sidebar (its context): the place shown, what is folded,
 * a task's word and run, a run's state with its panes, and the acts of a row.
 */
import type { ThreadView } from "../../shared/api/api.ts";
import type { Daemon } from "../../shared/daemon/daemon.tsx";
import type { BoardCard } from "../../shared/model/board.ts";
import type { FirstLevel } from "../../shared/model/look.ts";
import type { Route } from "../../shared/model/route.ts";
import type { Run, runWithPanes } from "../../shared/model/runs.ts";
import type { WorkTask } from "../../shared/model/tasks.ts";

export interface SidebarCtx {
  readonly route: Route;
  /** The run whose page is shown. */
  readonly current: string | undefined;
  /** What is folded or unfolded by hand, by key: a task, a thread, a group's finished tasks. */
  readonly expanded: Readonly<Record<string, boolean>>;
  fold(key: string, open: boolean): void;
  /** A task is unfolded by hand, or because it holds what is shown. */
  expandedNow(t: WorkTask): boolean;
  runOf(c: BoardCard): Run | undefined;
  /** A task's word as its row says it: a run of its own reads its panes too. */
  wordOf(t: WorkTask): FirstLevel;
  stateOf(r: Run): ReturnType<typeof runWithPanes>;
  readonly panesOf: Daemon["panesOf"];
  /** A run that asks on a card opens that decision on Home; else its page. */
  openDecisionOr(r: Run, pane?: string): void;
  onRun(r: Run, pane?: string): void;
  onThread(t: ThreadView): void;
  showMenu(thread: ThreadView, x: number, y: number): void;
  /** The thread that holds what is shown: unfolded, whatever was folded before. */
  readonly shownThread: ThreadView | undefined;
  /** In a folder: whose a chat is (`folder`, or its repository), for its row (ADR-0113). */
  placeOf(thread: ThreadView): string | undefined;
}
