/**
 * Reviews (round 18, a place of its own next to Backlog): the MRs MetatorAI watches (others',
 * reviewed here or where the person was asked to review) and my MRs, one word each. On the right
 * the chosen one: a watched MR's findings with their state badges and the reason of each, with
 * Re-review and Stop watching; my MR's threads with the proposed replies, a checkbox on each reply
 * to send, and "Send selected" (one consent for what is checked). A button that starts an agent
 * shows its terminal. The words are reviews.ts'; the daemon decides what is new and each state.
 */

import { useState } from "react";
import type { ReviewedRequest, ReviewView } from "../../shared/api/api.ts";
import { Freshness } from "../../shared/components/freshness.tsx";
import { Glyph } from "../../shared/components/glyph.tsx";
import { RepoSelect } from "../../shared/components/repo-select.tsx";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { useAction } from "../../shared/hooks.ts";
import { plural } from "../../shared/model/format.ts";
import { type Reading, readingOf } from "../../shared/model/freshness.ts";
import { lookOf } from "../../shared/model/look.ts";
import { navigate } from "../../shared/navigation.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyRow, ListDetail, ListRow, ListSection } from "../../ui/list-detail.tsx";
import { Notice } from "../../ui/notice.tsx";
import { useOpenRun } from "../runs/open-run.ts";
import {
  findingBadge,
  findingPlace,
  mineLine,
  mineWord,
  newsText,
  reviewGlyph,
  reviewTone,
  sendLabel,
  sendSelection,
  toSend,
  watchEnded,
  watchedLine,
  watchedWord,
} from "./model.ts";
import { useStartAgent } from "./review-card.tsx";

const NO_WATCHED: readonly ReviewView[] = [];
const NO_MINE: readonly ReviewedRequest[] = [];

export function ReviewsScreen({ id }: { readonly id?: string | undefined }) {
  const openRun = useOpenRun();
  const onOpen = (to: string) => navigate({ screen: "reviews", id: to });
  const onOpenSession = (runId: string) => openRun(runId);
  const { client, repo } = useDaemon("client", "repo");
  const watchedList = usePolled(`reviews:${repo ?? ""}`, () => client.reviews(repo), 2000);
  const mineList = usePolled(`mrs:${repo ?? ""}`, () => client.mrs(repo), 2000);
  const watched = watchedList.data?.reviews ?? NO_WATCHED;
  const mine = mineList.data?.requests ?? NO_MINE;
  const [showEnded, setShowEnded] = useState(false);
  const reload = async () => {
    await Promise.all([watchedList.reload(), mineList.reload()]);
  };
  const active = watched.filter((w) => !watchEnded(w.status));
  const ended = watched.filter((w) => watchEnded(w.status));
  const current: ReviewView | ReviewedRequest | undefined =
    watched.find((w) => w.id === id) ?? mine.find((m) => m.id === id) ?? active[0] ?? mine[0];
  // A list says it is empty only when the daemon said so: not while it is read, not when it failed.
  const watchedRead = readingOf(watchedList);
  const mineRead = readingOf(mineList);
  const known = (r: Reading) => r === "fresh" || r === "stale";
  const watchedRow = (w: ReviewView) => {
    const word = watchedWord(w.status);
    return (
      <ListRow
        key={w.id}
        className="item"
        testId={`review-${w.id}`}
        selected={current?.id === w.id}
        onSelect={() => onOpen(w.id)}
        glyph={<Glyph kind="first" state={reviewGlyph(word)} />}
        title={`#${w.number} ${w.title}`}
        sub={watchedLine(w)}
        trailing={<span className={`word ${reviewTone(word)}`}>{word}</span>}
      />
    );
  };
  return (
    <ListDetail
      className="backlog mrs reviews"
      testId="reviews"
      listLabel="reviews"
      top={
        <>
          <strong>Reviews</strong>
          <span className="dim">
            {plural(active.length, "watched MR")} · {plural(mine.length, "MR")} of mine
          </span>
          <span className="spacer" />
          <RepoSelect />
        </>
      }
      list={
        <>
          <ListSection>watched · {active.length}</ListSection>
          {active.map(watchedRow)}
          {watchedRead === "loading" ? <EmptyRow>Reading the watched MRs…</EmptyRow> : null}
          {known(watchedRead) && active.length === 0 ? (
            <EmptyRow>Nothing watched. Paste an MR's link into a chat and the agent reviews it.</EmptyRow>
          ) : null}
          <ListSection>mine · {mine.length}</ListSection>
          {mine.map((m) => {
            const word = mineWord(m);
            return (
              <ListRow
                key={m.id}
                className="item"
                testId={`mr-${m.id}`}
                selected={current?.id === m.id}
                onSelect={() => onOpen(m.id)}
                glyph={<Glyph kind="first" state={reviewGlyph(word)} />}
                title={`#${m.number} ${m.title}`}
                sub={mineLine(m)}
                trailing={<span className={`word ${reviewTone(word)}`}>{word}</span>}
              />
            );
          })}
          {mineRead === "loading" ? <EmptyRow>Reading your MRs…</EmptyRow> : null}
          {known(mineRead) && mine.length === 0 ? (
            <EmptyRow>
              No reviews of your MRs yet. Add a source under `codehost:` in metator.config.yml; the daemon
              looks every two minutes.
            </EmptyRow>
          ) : null}
          {ended.length > 0 ? (
            <>
              <span className="spacer" />
              <ListRow
                className="item dim"
                onSelect={() => setShowEnded(!showEnded)}
                title={`ended · ${ended.length} ${showEnded ? "▾" : "▸"}`}
              />
              {showEnded ? ended.map(watchedRow) : null}
            </>
          ) : null}
        </>
      }
    >
      <Freshness reads={[watchedList, mineList]} what="The reviews" />
      {current && "status" in current ? (
        <WatchedDetail key={current.id} review={current} reload={reload} onOpenSession={onOpenSession} />
      ) : current ? (
        <MineDetail key={current.id} request={current} reload={reload} onOpenSession={onOpenSession} />
      ) : null}
    </ListDetail>
  );
}

/** A watched MR: its findings with their state and reason; Review or Re-review, Stop watching. */
function WatchedDetail({
  review: w,
  reload,
  onOpenSession,
}: {
  readonly review: ReviewView;
  reload(): Promise<void>;
  onOpenSession(runId: string): void;
}) {
  const { client, repo } = useDaemon("client", "repo");
  const { start, action } = useStartAgent(reload);
  const unwatch = useAction(reload);
  const word = watchedWord(w.status);
  const news = watchEnded(w.status) ? undefined : newsText(w.news);
  const reviewing = w.status === "reviewing";
  return (
    <div className="review-detail" data-testid="review-detail">
      <Notice {...action.notice} />
      <Notice {...unwatch.notice} />
      <h2>
        #{w.number} {w.title} <span className={`word ${reviewTone(word)}`}>{word}</span>
      </h2>
      <div className="dim">
        by {w.author} · {w.head} → {w.base}
        {w.mode === "diff" ? " · reviewed from the diff only" : ""} ·{" "}
        <a href={w.url} target="_blank" rel="noreferrer">
          open at the host
        </a>
      </div>
      {news ? <div className="amber">{news} since the review</div> : null}
      {watchEnded(w.status) ? null : (
        <div className="actions">
          {w.status === "requested" ? (
            <Button
              variant="primary"
              disabled={action.busy}
              onClick={() => void start((by) => client.startReview(w.url, by, repo))}
            >
              Review
            </Button>
          ) : (
            <Button
              className={news ? "primary" : ""}
              data-testid="rereview"
              disabled={action.busy || reviewing}
              title={reviewing ? "a review runs now" : undefined}
              onClick={() => void start((by) => client.rereview(w.id, by, repo))}
            >
              Re-review
            </Button>
          )}
          {w.run && reviewing ? (
            <Button variant="ghost" onClick={() => onOpenSession(w.run?.runId as string)}>
              Open the review
            </Button>
          ) : null}
          <Button
            variant="ghost"
            data-testid="unwatch"
            onClick={() => void unwatch.run((by) => client.unwatchReview(w.id, by, repo), { who: true })}
          >
            Stop watching
          </Button>
        </div>
      )}
      <ul className="findings">
        {w.findings.map((f) => {
          const badge = findingBadge(f.state);
          const place = findingPlace(f);
          return (
            <li key={f.id} className={`finding ${f.state}`} data-testid={`finding-${f.id}`}>
              <div className="finding-head">
                <span className={`chip ${badge.tone ?? ""}`} data-testid="finding-state">
                  {badge.text}
                </span>
                {place ? <span className="mono dim">{place}</span> : <span className="dim">general</span>}
                <span className="faint">{f.severity}</span>
              </div>
              <div className="finding-text">{f.text}</div>
              {f.reason ? <div className="why dim">{f.reason}</div> : null}
            </li>
          );
        })}
        {w.findings.length === 0 ? <li className="dim">No findings.</li> : null}
      </ul>
    </div>
  );
}

/** My MR: its threads with the proposed replies; check which to send, then Send selected. */
function MineDetail({
  request: m,
  reload,
  onOpenSession,
}: {
  readonly request: ReviewedRequest;
  reload(): Promise<void>;
  onOpenSession(runId: string): void;
}) {
  const { client, repo, run: runOf } = useDaemon("client", "repo", "run");
  const action = useAction(reload);
  const { start, action: analyse } = useStartAgent(reload);
  // Every reply to send is checked until the person unchecks it.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const checked = new Set(m.threads.filter((t) => toSend(t) && !unchecked.has(t.id)).map((t) => t.id));
  const selection = sendSelection(m.threads, checked);
  const toggle = (thread: string) => {
    const next = new Set(unchecked);
    if (next.has(thread)) next.delete(thread);
    else next.add(thread);
    setUnchecked(next);
  };
  const run = runOf(m.runId, repo);
  const fresh = m.fresh ?? 0;
  return (
    <div className="review-detail" data-testid="mine-detail">
      <Notice {...action.notice} />
      <Notice {...analyse.notice} />
      <h2>
        #{m.number} {m.title} <span className={`word ${reviewTone(mineWord(m))}`}>{mineWord(m)}</span>
      </h2>
      <div className="row">
        {fresh > 0 ? (
          <Button
            variant="primary"
            disabled={analyse.busy}
            onClick={() => void start((by) => client.analyseMr(m.id, by, repo))}
          >
            Analyse {plural(fresh, "new thread")}
          </Button>
        ) : null}
        {m.runId ? (
          <>
            <span className="dim">answering run</span>{" "}
            <span>{run ? `${run.stage} · ${run.attention}` : "finished"}</span>
            <Button variant="ghost" onClick={() => onOpenSession(m.runId as string)}>
              Open session
            </Button>
          </>
        ) : null}
      </div>
      <div className="actions">
        <Button
          variant="primary"
          data-testid="send-replies"
          disabled={!selection || action.busy}
          onClick={() =>
            void action.run((by) => client.sendMrReplies(m.id, by, repo, selection?.only), { who: true })
          }
        >
          {sendLabel(selection)}
        </Button>
      </div>
      <div className="threads">
        {m.threads.map((t) => (
          <div className={`thread ${t.state}`} key={t.id} data-testid={`thread-${t.id}`}>
            <div className="dim mono">
              {lookOf("thread", t.state).glyph} {t.state} · {t.kind} · {t.author || "a reviewer"}
              {t.file ? ` · ${t.file}${t.line ? `:${t.line}` : ""}` : ""}
            </div>
            <blockquote>{t.body}</blockquote>
            {t.reply && toSend(t) ? (
              <label className="reply">
                <input
                  type="checkbox"
                  aria-label={`send the reply to ${t.author || "the reviewer"}`}
                  data-testid={`send-${t.id}`}
                  checked={checked.has(t.id)}
                  onChange={() => toggle(t.id)}
                />{" "}
                <span className="dim">proposed reply</span> {t.reply}
              </label>
            ) : t.reply ? (
              <div className="reply">
                <span className="dim">sent</span> {t.reply}
              </div>
            ) : null}
            {t.state !== "resolved" ? (
              <Button
                variant="ghost"
                onClick={() =>
                  void action.run((by) => client.resolveMrThread(m.id, t.id, by, repo), { who: true })
                }
              >
                Resolve
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
