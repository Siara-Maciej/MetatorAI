import type { MetatorError } from "../domain/errors.ts";
import { type IntakeConfig, type IntakeRule, intakeBody, sourceKey } from "../domain/intake.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { CodeHost } from "../ports/index.ts";
import type { Issues } from "./issues.ts";

export interface ScanIntakeDependencies {
  readonly config: IntakeConfig;
  readonly issues: Pick<Issues, "list" | "add" | "start">;
  readonly codeHost: CodeHost;
  /** Runs started by intake that are still active (against `maxActive`). */
  readonly activeRuns: () => Promise<Result<number, MetatorError>>;
  /**
   * Runs a scan while no other scan runs here, in this process or another (the daemon's tick and
   * `metator intake scan`): two scans at once would each make an issue and a run of the same item.
   */
  readonly exclusive?: <T>(work: () => Promise<Result<T, MetatorError>>) => Promise<Result<T, MetatorError>>;
}

export interface IntakeRuleReport {
  readonly rule: string;
  /** Items the source listed for the rule. */
  readonly listed: number;
  /** Listed items the backlog already holds (by source key). */
  readonly known: number;
  /** Source keys seen for the first time in this scan. */
  readonly new: readonly string[];
  readonly started: readonly { readonly issue: string; readonly runId: string }[];
  /** Issues of the rule that wait for a free slot (`maxActive`). */
  readonly waiting: readonly string[];
  /** Why the source could not be read; the other rules are scanned all the same. */
  readonly error?: string;
}

export interface IntakeReport {
  readonly rules: readonly IntakeRuleReport[];
  readonly started: number;
}

/**
 * One scan of every intake rule (T2, design/14 §3): each item the source lists that the backlog
 * does not hold yet becomes an issue (decided by `intake:<rule>`, with its source key) and a run
 * under the rule's workflow, as long as `maxActive` allows; the rest wait as open issues and
 * start on a later scan. An item's text is quoted in the issue as data. Nothing is ever changed
 * at the source.
 */
export class ScanIntake {
  constructor(private readonly d: ScanIntakeDependencies) {}

  async execute(input: { readonly dryRun?: boolean } = {}): Promise<Result<IntakeReport, MetatorError>> {
    // A dry run writes nothing, so it waits for nobody.
    if (input.dryRun === true || !this.d.exclusive) return this.scan(input.dryRun === true);
    return this.d.exclusive(() => this.scan(false));
  }

  private async scan(dryRun: boolean): Promise<Result<IntakeReport, MetatorError>> {
    const active = await this.d.activeRuns();
    if (active.isErr()) return err(active.error);
    let free = Math.max(0, this.d.config.maxActive - active.value);
    const rules: IntakeRuleReport[] = [];
    for (const rule of this.d.config.rules) {
      const report = await this.scanRule(rule, dryRun, free);
      if (report.isErr()) return err(report.error);
      free -= report.value.started.length;
      rules.push(report.value);
    }
    return ok({ rules, started: rules.reduce((n, r) => n + r.started.length, 0) });
  }

  private async scanRule(
    rule: IntakeRule,
    dryRun: boolean,
    free: number,
  ): Promise<Result<IntakeRuleReport, MetatorError>> {
    const listed = await this.d.codeHost.listItems(rule.source);
    if (listed.isErr())
      return ok({
        rule: rule.id,
        listed: 0,
        known: 0,
        new: [],
        started: [],
        waiting: [],
        error: listed.error.message,
      });
    const backlog = await this.d.issues.list();
    if (backlog.isErr()) return err(backlog.error);
    const held = new Set(backlog.value.flatMap((i) => (i.source ? [i.source.key] : [])));
    const fresh = listed.value
      .map((item) => ({ item, key: sourceKey(rule.source, item.ref) }))
      .filter((x) => !held.has(x.key));
    const base = {
      rule: rule.id,
      listed: listed.value.length,
      known: listed.value.length - fresh.length,
      new: fresh.map((x) => x.key),
    };
    if (dryRun) return ok({ ...base, started: [], waiting: [] });
    // Issues of this rule that waited for a slot come first, then the new ones, oldest first.
    const queue = backlog.value
      .filter((i) => i.source?.rule === rule.id && i.status === "open" && !i.runId)
      .map((i) => i.id);
    for (const { item, key } of fresh) {
      const added = await this.d.issues.add({
        title: item.title,
        body: intakeBody(item, key),
        labels: item.labels,
        by: `intake:${rule.id}`,
        source: { key, rule: rule.id, ...(item.url ? { url: item.url } : {}) },
      });
      if (added.isErr()) return err(added.error);
      queue.push(added.value.id);
    }
    const started: { issue: string; runId: string }[] = [];
    const waiting: string[] = [];
    for (const id of queue) {
      if (started.length >= free) {
        waiting.push(id);
        continue;
      }
      const run = await this.d.issues.start(id, {
        workflow: rule.workflow,
        worktree: rule.worktree,
        // Nobody is there to commit or stash: a run from an issue starts from the last commit and
        // never needs the uncommitted work of whoever sits at the checkout.
        allowDirty: true,
        ...(rule.autonomy === "full" ? { autonomy: "L1" as const } : {}),
      });
      if (run.isErr()) return err(run.error);
      started.push({ issue: id, runId: run.value.runId });
    }
    return ok({ ...base, started, waiting });
  }
}
