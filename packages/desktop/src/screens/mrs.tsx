/**
 * Open MRs (T3, design/14 §4): my pull requests that were reviewed. On the left the requests
 * with their open threads; on the right the chosen one: every thread with who said what where,
 * what the agent made of it (kind, proposed reply), and the decisions that are a person's:
 * send the replies, resolve a thread, open the answering run or its plan.
 */
import type { ReviewedRequest } from "../api.ts";
import { Notice, RepoSelect } from "../components/common.tsx";
import { Glyph } from "../components/glyph.tsx";
import { EmptyRow, ListDetail, ListRow, ListSection } from "../components/list-detail.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { lookOf, plural } from "../model.ts";

const NO_REQUESTS: readonly ReviewedRequest[] = [];

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
  const { client, repo, run: runOf } = useDaemon();
  const list = usePolled(`mrs:${repo ?? ""}`, () => client.mrs(repo), 2000);
  const requests = list.data?.requests ?? NO_REQUESTS;
  // What an action answered stays until closed (D5).
  const action = useAction(list.reload);
  const current = requests.find((r) => r.id === id) ?? requests[0];
  const open = (r: ReviewedRequest) => r.threads.filter((t) => t.state === "open").length;
  const proposed = (r: ReviewedRequest) => r.threads.filter((t) => t.reply && !t.repliedAt).length;
  const run = runOf(current?.runId, repo);
  return (
    <ListDetail
      className="backlog mrs"
      testId="mrs"
      listLabel="my reviewed requests"
      top={
        <>
          <strong>Open MRs</strong>
          <span className="dim">
            {requests.length} reviewed · {requests.reduce((n, r) => n + open(r), 0)} open thread(s)
          </span>
          <span className="spacer" />
          <RepoSelect />
        </>
      }
      list={
        <>
          <ListSection>my reviewed requests · {requests.length}</ListSection>
          {requests.map((r) => (
            <ListRow
              key={r.id}
              className="item"
              testId={`mr-${r.id}`}
              selected={current?.id === r.id}
              onSelect={() => onOpen(r.id)}
              glyph={<Glyph kind="thread" state={open(r) > 0 ? "open" : "resolved"} />}
              title={`#${r.number} ${r.title}`}
              sub={`${open(r)} open · ${plural(proposed(r), "reply", "replies")} to send${r.branch ? ` · ${r.branch}` : ""}`}
            />
          ))}
          {requests.length === 0 ? (
            <EmptyRow>
              No reviews yet. Add a source under `reviews:` in metator.config.yml; the daemon reads it every
              two minutes.
            </EmptyRow>
          ) : null}
        </>
      }
    >
      {list.error && !list.data ? <div className="banner">{list.error}</div> : null}
      <Notice {...action.notice} />
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
                <button type="button" className="ghost" onClick={() => onOpenPlan(current.runId as string)}>
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
              className="primary"
              data-testid="send-replies"
              disabled={proposed(current) === 0}
              onClick={() =>
                void action.run((by) => client.sendMrReplies(current.id, by, repo), { who: true })
              }
            >
              Send {plural(proposed(current), "reply", "replies")}
            </button>
          </div>
          <div className="threads">
            {current.threads.map((t) => (
              <div className={`thread ${t.state}`} key={t.id} data-testid={`thread-${t.id}`}>
                <div className="dim mono">
                  {lookOf("thread", t.state).glyph} {t.state} · {t.kind} · {t.author || "a reviewer"}
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
                    onClick={() =>
                      void action.run((by) => client.resolveMrThread(current.id, t.id, by, repo), {
                        who: true,
                      })
                    }
                  >
                    Resolve
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </ListDetail>
  );
}
