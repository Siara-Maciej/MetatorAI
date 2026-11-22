import { unmetDependencies } from "./dependencies.ts";
import { MetatorError } from "./errors.ts";
import type { Issue, Snapshot } from "./issue.ts";
import type { Plan } from "./plan.ts";
import type { SystemPlan } from "./system-plan.ts";

/**
 * An item's analysis and plan in the Backlog (ADR-0096): what they cite, whether they still hold
 * (freshness, decided from file hashes and the commit they were made at, never by a model), the
 * items a plan becomes (a parent and its children), and what a parent and its children show.
 */

/** Whether an analysis or a plan still holds: one answer per snapshot. */
export type Freshness =
  | { readonly state: "fresh" }
  | { readonly state: "stale"; readonly changed: readonly string[] }
  | { readonly state: "old"; readonly days: number };

const DAY_MS = 86_400_000;

/**
 * `path:line` references in a text (an agent cites every claim so), repository-relative and in
 * the order they first appear. A URL, an absolute path and a path that leaves the repository are not citations.
 */
export function citedPaths(text: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|[\s(`'"<[,;])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]+):\d+/g;
  for (const m of text.matchAll(pattern)) {
    const path = m[1] as string;
    if (path.split("/").includes("..") || found.includes(path)) continue;
    found.push(path);
  }
  return found;
}

/** What a plan cites: each step's file, the tests written first, its exemplar, and the files its intent names. */
export function planCites(plan: Pick<Plan, "steps">): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  for (const s of plan.steps) {
    add(s.path);
    for (const t of s.testsFirst) add(t);
    if (s.patternSource) add(s.patternSource.exemplar.replace(/:\d+$/, ""));
  }
  for (const s of plan.steps) for (const p of citedPaths(s.intent)) add(p);
  return out;
}

const inside = (file: string, dirs: readonly string[]) =>
  dirs.some((d) => d === "." || file === d || file.startsWith(`${d}/`));

/**
 * Whether a snapshot still holds. Stale: a cited file's content differs from its hash (or it is
 * gone: hash ""), or a file of one of its packages changed since the snapshot (`changed`: the
 * files that differ from its commit now, in this checkout); a file that already differed then
 * (`dirty`) counts only when its content is no longer what it was. Otherwise old once more than
 * `staleDays` whole days passed: only a warning. Otherwise fresh.
 */
export function freshnessOf(input: {
  readonly snapshot: Snapshot;
  /** The current content hash of a file, "" when it does not exist. */
  readonly hash: (path: string) => string;
  readonly changed: readonly string[];
  /** The directories of the snapshot's packages. */
  readonly packageDirs: readonly string[];
  readonly now: Date;
  readonly staleDays: number;
}): Freshness {
  const { snapshot } = input;
  const changedNow = new Set(input.changed);
  const then = new Map((snapshot.dirty ?? []).map((d) => [d.path, d.sha256]));
  const out = new Set<string>();
  for (const c of snapshot.cites) if (input.hash(c.path) !== c.sha256) out.add(c.path);
  const candidates = new Set([...input.changed.filter((f) => inside(f, input.packageDirs)), ...then.keys()]);
  for (const f of candidates) {
    const before = then.get(f);
    // Not changed then: any change now counts. Changed then: it counts unless it is as it was.
    if (before === undefined ? changedNow.has(f) : !changedNow.has(f) || input.hash(f) !== before) out.add(f);
  }
  if (out.size > 0) return { state: "stale", changed: [...out].sort() };
  const elapsed = input.now.getTime() - Date.parse(snapshot.at);
  return elapsed > input.staleDays * DAY_MS
    ? { state: "old", days: Math.floor(elapsed / DAY_MS) }
    : { state: "fresh" };
}

/** A plan as the Backlog shows it: its task, then one line per step. */
export function planSummary(plan: Pick<Plan, "task" | "steps">): string {
  return `${plan.task}\n\n${plan.steps.map((s) => `- ${s.id} ${s.action} ${s.path}: ${s.intent}`).join("\n")}\n`;
}

/** A system plan as the Backlog shows it: its task, then one line per step with its application. */
export function systemPlanSummary(plan: Pick<SystemPlan, "task" | "steps">): string {
  const line = (s: SystemPlan["steps"][number]) =>
    `- ${s.id} (${s.app}): ${s.summary}${s.dependsOn.length > 0 ? ` (after ${s.dependsOn.join(", ")})` : ""}`;
  return `${plan.task}\n\n${plan.steps.map(line).join("\n")}\n`;
}

/** The text of an item made from a plan; the use case adds who, when and the snapshot. */
export interface PlanItem {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly parent?: string;
  readonly dependsOn?: readonly string[];
  readonly step?: NonNullable<Issue["step"]>;
}

const TITLE_MAX = 200;
const titleOf = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

/**
 * The Backlog items a plan becomes: one parent (the task and the plan's summary) and, for a
 * system plan, one child per step whose `dependsOn` are the children of the steps it depends on.
 * A single-repository plan has no phases (Plan v1): the parent alone. `ids` are the free ids, in order.
 */
export function backlogFromPlan(input: {
  readonly ids: readonly string[];
  readonly runId: string;
  readonly title: string;
  readonly body: string;
  readonly system?: Pick<SystemPlan, "id" | "steps">;
}): { readonly parent: PlanItem; readonly children: readonly PlanItem[] } {
  const [parentId, ...rest] = input.ids;
  const parent: PlanItem = { id: parentId as string, title: titleOf(input.title), body: input.body };
  const steps = input.system?.steps ?? [];
  const idOf = new Map(steps.map((s, i) => [s.id, rest[i] as string]));
  const children = steps.map(
    (s): PlanItem => ({
      id: idOf.get(s.id) as string,
      title: titleOf(s.summary),
      body: `Step ${s.id} of system plan ${input.system?.id}, in ${s.app}.${s.dependsOn.length > 0 ? ` After ${s.dependsOn.join(", ")}.` : ""}`,
      parent: parent.id,
      dependsOn: s.dependsOn.flatMap((d) => (idOf.has(d) ? [idOf.get(d) as string] : [])),
      step: { runId: input.runId, plan: input.system?.id as string, stepId: s.id },
    }),
  );
  return { parent, children };
}

/** Done, or dropped: nothing more will happen to it, so whatever waits for it may go on. */
export const isSettled = (i: Pick<Issue, "status">): boolean => i.status === "done" || i.status === "dropped";

/** The parents that are done by themselves: not settled yet, and every child is done or dropped. */
export function settledParents(items: readonly Issue[]): string[] {
  return items
    .filter((p) => !isSettled(p) && p.status !== "proposed")
    .filter((p) => {
      const children = items.filter((c) => c.parent === p.id);
      return children.length > 0 && children.every(isSettled);
    })
    .map((p) => p.id);
}

/** An item as the Backlog lists it: its children, what it waits for, and a parent's progress. */
export type IssueLinks = Issue & {
  readonly children: readonly string[];
  readonly waitsFor: readonly string[];
  readonly progress?: { readonly done: number; readonly of: number };
};

export function issueViews(items: readonly Issue[]): IssueLinks[] {
  return items.map((i) => {
    const children = items.filter((c) => c.parent === i.id).sort((a, b) => a.id.localeCompare(b.id));
    return {
      ...i,
      children: children.map((c) => c.id),
      waitsFor: unmetDependencies(i, items, isSettled),
      ...(children.length > 0
        ? { progress: { done: children.filter(isSettled).length, of: children.length } }
        : {}),
    };
  });
}

/** Why an item may not start yet: the items it depends on that are not done (the shared rule), named with their state. */
export function waitRefusal(issue: Issue, items: readonly Issue[]): MetatorError | undefined {
  const waits = unmetDependencies(issue, items, isSettled);
  if (waits.length === 0) return undefined;
  const named = waits.map((w) => `${w} (${items.find((i) => i.id === w)?.status ?? "missing"})`);
  return MetatorError.usage(
    `issue ${issue.id} waits for ${named.join(", ")}: start it when they are done`,
    "`metator issue list` shows what each item waits for.",
  );
}

/** The workflow an item's run follows unless a person names one: a bug's, else a feature's. */
export const workflowFor = (issue: Pick<Issue, "labels">): string =>
  issue.labels.some((l) => l.toLowerCase() === "bug") ? "mt-bugfix" : "mt-feature";

/** What the guide is told when "Analyse" opens its pane: the item, and how to record the analysis. */
export function analysePrompt(issue: Pick<Issue, "id" | "title" | "body">): string {
  return [
    `Analyse Backlog item ${issue.id} ("${issue.title}") for the person: where it lives in this repository, what it touches, what is risky, and how you would approach it. Read only; cite every claim as path:line.`,
    issue.body.trim() ? `The item says: ${issue.body.trim().replace(/\s+/g, " ")}` : "",
    `When the analysis is done, record it with \`metator issue analyze --issue ${issue.id} --text -\` and the whole text on stdin (a heredoc), then tell the person it is in the Backlog.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** What a run that plans an item reads first (task.md): the item, then its analysis. */
export function planBrief(issue: Pick<Issue, "id" | "title" | "body">, analysis: string | undefined): string {
  const body = issue.body.trim() ? `${issue.body.trim()}\n\n` : "";
  const studied = analysis?.trim() ? `## Analysis\n\n${analysis.trim()}\n\n` : "";
  return `# ${issue.title}\n\n${body}${studied}From issue ${issue.id}.\n`;
}

/** What MetatorAI adds to an analysis: facts read from the repository, not the agent's words. */
export interface AnalysisFacts {
  readonly at: string;
  readonly commit: string;
  readonly cited: readonly string[];
  readonly missing: readonly string[];
  readonly packages: readonly string[];
  /** Files that import each cited file, transitively (`graph dependents --transitive`). */
  readonly dependents: readonly { readonly path: string; readonly count: number }[];
  /** How the repository already does it (`similar`), by cited file. */
  readonly exemplars: readonly { readonly path: string; readonly pattern: string; readonly at: string }[];
}

const code = (p: string) => `\`${p}\``;

/** The "Deterministic facts" section appended to `analysis.md`. */
export function analysisFactsSection(f: AnalysisFacts): string {
  const lines = [
    "## Deterministic facts",
    "",
    `Recorded by MetatorAI at ${f.at}, commit ${f.commit.slice(0, 12)}.`,
    "",
    `- Cited files (${f.cited.length}): ${f.cited.map(code).join(", ") || "none"}`,
    ...(f.missing.length > 0 ? [`- Not found: ${f.missing.map(code).join(", ")}`] : []),
    `- Packages: ${f.packages.join(", ") || "none"}`,
    ...(f.dependents.length > 0
      ? [
          `- Dependents (\`metator graph dependents --transitive\`): ${f.dependents.map((d) => `${code(d.path)} ${d.count}`).join(", ")}`,
        ]
      : []),
    ...(f.exemplars.length > 0
      ? [
          `- Exemplars (\`metator similar\`): ${f.exemplars.map((e) => `${code(e.path)} → ${e.pattern} (${code(e.at)})`).join(", ")}`,
        ]
      : []),
  ];
  return `${lines.join("\n")}\n`;
}

/** The line a new thread's chat gets when an item starts: the old thread's summary and where the item's texts are. */
export function startCarry(
  issue: Pick<Issue, "id" | "title" | "analysis" | "plan">,
  oldSummary: string | undefined,
): string {
  const summary = (oldSummary ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return [
    `Backlog item ${issue.id} "${issue.title}" started.`,
    summary,
    issue.analysis ? `Analysis: ${issue.analysis.file}.` : "",
    issue.plan ? `Plan: ${issue.plan.file}.` : "",
  ]
    .filter((p) => p !== "")
    .join(" ");
}
