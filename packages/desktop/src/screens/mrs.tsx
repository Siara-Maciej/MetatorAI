/**
 * Open MRs (T3, design/14 §4): my pull requests that were reviewed. On the left the requests
 * with their open threads; on the right the chosen one: every thread with who said what where,
 * what the agent made of it (kind, proposed reply), and the decisions that are a person's:
 * send the replies, resolve a thread, open the answering run or its plan.
 */
import { useState } from "react";
import type { ReviewedRequest, ReviewThreadView } from "../api.ts";
import { Notice, RepoSelect } from "../components/common.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";

const NO_REQUESTS: readonly ReviewedRequest[] = [];

const GLYPH: Record<ReviewThreadView["state"], string> = {
  open: "○",
  answered: "↩",
  planned: "⋮",
  fixed: "✓",
  resolved: "✓",
};

export function MrsScreen({
  id,
  onOpen,
  onOpenSession,
  onOpenPlan,
}: {
  readonly id?: string | undefined;
  onOpen(id: string): void;
  onOpenSession(runId: string): void;
  onOpenPlan(runId: string): void;
}) {
  const { client, repo, runs, who } = useDaemon();
  const list = usePolled(`mrs:${repo ?? ""}`, () => client.mrs(repo), 2000);
  const requests = list.data?.requests ?? NO_REQUESTS;
  // What an action answered stays until closed (D5).
  const [note, setNote] = useState<string>();
  const current = requests.find((r) => r.id === id) ?? requests[0];
  const open = (r: ReviewedRequest) => r.threads.filter((t) => t.state === "open").length;
  const proposed = (r: ReviewedRequest) => r.threads.filter((t) => t.reply && !t.repliedAt).length;
  const run = current?.runId ? runs.find((r) => r.runId === current.runId) : undefined;
  const act = async (what: (by: string) => Promise<{ ok: boolean; error?: { message: string } }>) => {
    const by = await who();
    if (!by) return;
    const r = await what(by);
    setNote(r.ok ? undefined : (r.error?.message ?? "the daemon refused"));
    await list.reload();
  };
  return (
    <div className="backlog mrs" data-testid="mrs">
      <div className="top">
        <strong>Open MRs</strong>
        <span className="dim">
          {requests.length} reviewed · {requests.reduce((n, r) => n + open(r), 0)} open thread(s)
        </span>
        <span className="spacer" />
        <RepoSelect />
      </div>
      <div className="body">
        <aside className="list">
          <div className="sec">my reviewed requests · {requests.length}</div>
          {requests.map((r) => (
            <button
              type="button"
              key={r.id}
              data-testid={`mr-${r.id}`}
              className={`item${current?.id === r.id ? " sel" : ""}`}
              onClick={() => onOpen(r.id)}
            >
              <span className="g">{open(r) > 0 ? "○" : "✓"}</span>
              <span className="n">
                #{r.number} {r.title}
                <span className="sub dim">
                  {open(r)} open · {proposed(r)} repl{proposed(r) === 1 ? "y" : "ies"} to send
                  {r.branch ? ` · ${r.branch}` : ""}
                </span>
              </span>
            </button>
          ))}
          {requests.length === 0 ? (
            <div className="dim" style={{ padding: "6px 20px" }}>
              No reviews yet. Add a source under `reviews:` in metator.config.yml; the daemon reads it every
              two minutes.
            </div>
          ) : null}
        </aside>
        <main className="detail">
          {list.error && !list.data ? <div className="banner">{list.error}</div> : null}
          <Notice text={note} onClose={() => setNote(undefined)} />
          {current ? (
            <>
              <div className="dim mono">
                {current.id}
                {current.url ? ` · ${current.url}` : ""}
              </div>
              <h2>
                #{current.number} {current.title}
              </h2>
              <div className="row">
                <span className="dim">answering run</span>{" "}
                {current.runId ? (
                  <>
                    <span>{run ? `${run.stage} · ${run.attention}` : "finished"}</span>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => onOpenSession(current.runId as string)}
                    >
                      Open session
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => onOpenPlan(current.runId as string)}
                    >
                      Plan
                    </button>
                  </>
                ) : (
                  <span>none yet</span>
                )}
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="go"
                  data-testid="send-replies"
                  disabled={proposed(current) === 0}
                  onClick={() => void act((by) => client.sendMrReplies(current.id, by, repo))}
                >
                  Send {proposed(current)} repl{proposed(current) === 1 ? "y" : "ies"}
                </button>
              </div>
              <div className="threads">
                {current.threads.map((t) => (
                  <div className={`thread ${t.state}`} key={t.id} data-testid={`thread-${t.id}`}>
                    <div className="dim mono">
                      {GLYPH[t.state]} {t.state} · {t.kind} · {t.author || "a reviewer"}
                      {t.file ? ` · ${t.file}${t.line ? `:${t.line}` : ""}` : ""}
                    </div>
                    <blockquote>{t.body}</blockquote>
                    {t.reply ? (
                      <div className="reply">
                        <span className="dim">{t.repliedAt ? "sent" : "proposed reply"}</span> {t.reply}
                      </div>
                    ) : null}
                    {t.state !== "resolved" ? (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void act((by) => client.resolveMrThread(current.id, t.id, by, repo))}
                      >
                        Resolve
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
