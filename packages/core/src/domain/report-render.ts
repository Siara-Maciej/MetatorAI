import type { ReactionStats } from "./review-feedback.ts";
import type { FleetReport } from "./telemetry.ts";

/**
 * The dashboard (F5): the fleet report and the reactions to review comments as one HTML page,
 * for a browser or a wiki, with no script and no dependency. Numbers are the report's own; the
 * page only lays them out.
 */
export function renderReportHtml(report: FleetReport, reactions: ReactionStats, generatedAt: Date): string {
  const t = report.totals;
  const tile = (label: string, value: string, note = "") =>
    `<div class="tile"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>${note ? `<div class="n">${esc(note)}</div>` : ""}</div>`;
  const row = (cells: readonly (string | number)[]) =>
    `<tr>${cells.map((c) => `<td>${esc(String(c))}</td>`).join("")}</tr>`;
  const head = (cells: readonly string[]) => `<tr>${cells.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  const runs = report.runs.map((r) =>
    row([
      r.runId,
      r.workflow,
      r.status,
      duration(r.wallMs),
      r.usage.calls,
      usd(r.usage.costUsd),
      r.questions.asked,
      r.questions.byPolicy,
      duration(r.questions.waitMs),
      r.failures,
    ]),
  );
  const agents = report.agents.map((a) =>
    row([
      a.agent,
      a.calls,
      duration(a.agentMs),
      a.inputTokens + a.outputTokens,
      usd(a.costUsd),
      a.failed,
      a.questions,
    ]),
  );
  const lenses = Object.entries(reactions.byLens).map(([lens, c]) =>
    row([lens, c.total, c.resolved, c.dismissed, c.open, pct(c.dismissedShare)]),
  );
  const prs = Object.entries(reactions.byPr).map(([pr, c]) =>
    row([pr, c.total, c.resolved, c.dismissed, c.open, pct(c.dismissedShare)]),
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MetatorAI report</title>
<style>
:root{--bg:#0f1319;--panel:#151a22;--edge:#273040;--text:#e6e9ef;--dim:#8b95a7;--teal:#2dd4bf;--amber:#f0b429;--red:#f87171}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:24px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:28px 0 8px;color:var(--dim);letter-spacing:.06em;text-transform:uppercase}
.dim{color:var(--dim)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:16px}
.tile{background:var(--panel);border:1px solid var(--edge);border-radius:6px;padding:12px 14px}.tile .v{font-size:22px}.tile .l{color:var(--dim);font-size:12px}.tile .n{font-size:11px;color:var(--amber);margin-top:4px}
table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--edge)}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--edge);white-space:nowrap}th{color:var(--dim);font-weight:normal;font-size:12px}
.good{color:var(--teal)}.bad{color:var(--red)}
</style></head><body>
<h1>MetatorAI report</h1>
<div class="dim">generated ${esc(generatedAt.toISOString())} · ${t.runs} run(s), ${t.done} done</div>
<div class="tiles">
${tile("agent calls", String(t.calls))}
${tile("agent time", duration(t.agentMs))}
${tile("tokens in / out", `${t.inputTokens} / ${t.outputTokens}`, t.cachedTokens > 0 ? `${t.cachedTokens} from cache` : "")}
${tile("cost", usd(t.costUsd))}
${tile("questions", String(t.questions), t.byPolicy > 0 ? `${t.byPolicy} answered by a policy` : "")}
${tile("people waited", duration(t.personWaitMs))}
${tile("sent back by gates", String(t.failures))}
${tile("review comments dismissed", pct(reactions.dismissedShare), reactions.total === 0 ? "no reactions recorded" : reactions.dismissedShare > 0.15 ? "above the 15% line" : "within the 15% line")}
</div>
<h2>Runs</h2>
<table>${head(["run", "workflow", "status", "wall", "calls", "cost", "questions", "by policy", "waited", "sent back"])}${runs.join("") || row(["no runs", "", "", "", "", "", "", "", "", ""])}</table>
<h2>Agents</h2>
<table>${head(["agent", "calls", "time", "tokens", "cost", "failed", "questions"])}${agents.join("") || row(["no calls", "", "", "", "", "", ""])}</table>
<h2>Reactions to review comments, by lens</h2>
<table>${head(["lens", "comments", "resolved", "dismissed", "open", "dismissed share"])}${lenses.join("") || row(["none recorded", "", "", "", "", ""])}</table>
<h2>Reactions by pull request</h2>
<table>${head(["pull request", "comments", "resolved", "dismissed", "open", "dismissed share"])}${prs.join("") || row(["none recorded", "", "", "", "", ""])}</table>
<p class="dim">Record a reaction with <code>metator findings react &lt;finding&gt; --pr &lt;n&gt; --state resolved|dismissed|open --by &lt;who&gt;</code>; the numbers above come from <code>metator report</code>.</p>
</body></html>
`;
}

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;
export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
