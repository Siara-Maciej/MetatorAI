/**
 * Reviews (round 18, a place of its own next to Backlog): the MRs MetatorAI watches (others',
 * reviewed here or where the person was asked to review) and my MRs, one word each. On the right
 * the chosen one: a watched MR's findings with their state badges and the reason of each, with
 * Re-review and Stop watching; my MR's threads with the proposed replies, a checkbox on each reply
 * to send, and "Send selected" (one consent for what is checked). A button that starts an agent
 * shows its terminal. The words are reviews.ts'; the daemon decides what is new and each state.
 *
 * The screen only lays its parts out (ADR-0113): what it keeps is the Reviews store (`state.ts`),
 * and each part reads only the value it draws, so choosing an MR draws two rows and the detail.
 */

import { useEffect } from "react";
import { useStore } from "zustand";
import type { ReviewedRequest, ReviewView } from "../../shared/api/api.ts";
import { Freshness } from "../../shared/components/freshness.tsx";
import { Glyph } from "../../shared/components/glyph.tsx";
import { RepoSelect } from "../../shared/components/repo-select.tsx";
import { useDaemonStore } from "../../shared/daemon/daemon.tsx";
import { plural } from "../../shared/model/format.ts";
import { type Reading, readingOf } from "../../shared/model/freshness.ts";
import { lookOf } from "../../shared/model/look.ts";
import { navigate } from "../../shared/navigation.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { EmptyRow, ListDetail, ListRow, ListSection } from "../../ui/list-detail.tsx";
import { Notice } from "../../ui/notice.tsx";
import { useOpenRun } from "../runs/open-run.ts";
import {
  useCurrent,
  useIsCurrent,
  useMine,
  useMineOne,
  useReads,
  useReviewsDaemon,
  useWatched,
  useWatchedOne,
} from "./data.ts";
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
import { Reviews, useReviews, useReviewsApi } from "./state.ts";

export function ReviewsScreen({ id }: { readonly id?: string | undefined }) {
  const daemon = useDaemonStore();
  return (
    <ScopeProvider store={Reviews} init={{ daemon, routeId: id }}>
      <RouteToReview id={id} />
      <ListDetail
        className="backlog mrs reviews"
        testId="reviews"
        listLabel="reviews"
        top={<ReviewsTop />}
        list={<ReviewsList />}
      >
        <ReviewsFreshness />
        <CurrentDetail />
      </ListDetail>
    </ScopeProvider>
  );
}

/** The route's MR is the one shown when the route changes (a row's click goes through the route). */
function RouteToReview({ id }: { readonly id: string | undefined }) {
  const routeTo = useReviews((s) => s.routeTo);
  useEffect(() => routeTo(id), [id, routeTo]);
  return null;
}

function ReviewsTop() {
  const active = useWatched((l) => l.filter((w) => !watchEnded(w.status)).length);
  const mine = useMine((l) => l.length);
  return (
    <>
      <strong>Reviews</strong>
      <span className="dim">
        {plural(active, "watched MR")} · {plural(mine, "MR")} of mine
      </span>
      <span className="spacer" />
      <RepoSelect />
    </>
  );
}

const ids = (list: readonly { readonly id: string }[]): string => list.map((x) => x.id).join("\n");
const split = (joined: string): readonly string[] => (joined === "" ? [] : joined.split("\n"));
/** A list says it is empty only when the daemon said so: not while it is read, not when it failed. */
const known = (r: Reading) => r === "fresh" || r === "stale";

function ReviewsList() {
  // The ids as one string: the list draws again only when an MR came or went.
  const active = split(useWatched((l) => ids(l.filter((w) => !watchEnded(w.status)))));
  const mine = split(useMine(ids));
  return (
    <>
      <ListSection>watched · {active.length}</ListSection>
      {active.map((id) => (
        <WatchedRow key={id} id={id} />
      ))}
      <ListEmpty which="watched" count={active.length} />
      <ListSection>mine · {mine.length}</ListSection>
      {mine.map((id) => (
        <MineRow key={id} id={id} />
      ))}
      <ListEmpty which="mine" count={mine.length} />
      <EndedRows />
    </>
  );
}

/** "Reading…" while a list is read, and the empty line once the daemon said it has none. */
function ListEmpty({ which, count }: { readonly which: "watched" | "mine"; readonly count: number }) {
  const reads = useReads();
  const read = readingOf(reads[which]);
  if (read === "loading")
    return <EmptyRow>{which === "watched" ? "Reading the watched MRs…" : "Reading your MRs…"}</EmptyRow>;
  if (!known(read) || count > 0) return null;
  return which === "watched" ? (
    <EmptyRow>Nothing watched. Paste an MR's link into a chat and the agent reviews it.</EmptyRow>
  ) : (
    <EmptyRow>
      No reviews of your MRs yet. Add a source under `codehost:` in metator.config.yml; the daemon looks every
      two minutes.
    </EmptyRow>
  );
}

function EndedRows() {
  const ended = split(useWatched((l) => ids(l.filter((w) => watchEnded(w.status)))));
  const showEnded = useReviews((s) => s.showEnded);
  const toggleEnded = useReviews((s) => s.toggleEnded);
  if (ended.length === 0) return null;
  return (
    <>
      <span className="spacer" />
      <ListRow
        className="item dim"
        onSelect={toggleEnded}
        title={`ended · ${ended.length} ${showEnded ? "▾" : "▸"}`}
      />
      {showEnded ? ended.map((id) => <WatchedRow key={id} id={id} />) : null}
    </>
  );
}

const open = (id: string) => navigate({ screen: "reviews", id });

/** A watched MR's row: its own MR, and whether it is the one shown. */
export function WatchedRow({ id }: { readonly id: string }) {
  const w = useWatchedOne(id);
  const selected = useIsCurrent(id);
  if (!w) return null;
  const word = watchedWord(w.status);
  return (
    <ListRow
      className="item"
      testId={`review-${w.id}`}
      selected={selected}
      onSelect={() => open(w.id)}
      glyph={<Glyph kind="first" state={reviewGlyph(word)} />}
      title={`#${w.number} ${w.title}`}
      sub={watchedLine(w)}
      trailing={<span className={`word ${reviewTone(word)}`}>{word}</span>}
    />
  );
}

/** One of my MRs' row. */
export function MineRow({ id }: { readonly id: string }) {
  const m = useMineOne(id);
  const selected = useIsCurrent(id);
  if (!m) return null;
  const word = mineWord(m);
  return (
    <ListRow
      className="item"
      testId={`mr-${m.id}`}
      selected={selected}
      onSelect={() => open(m.id)}
      glyph={<Glyph kind="first" state={reviewGlyph(word)} />}
      title={`#${m.number} ${m.title}`}
      sub={mineLine(m)}
      trailing={<span className={`word ${reviewTone(word)}`}>{word}</span>}
    />
  );
}

function ReviewsFreshness() {
  const { watched, mine } = useReads();
  return <Freshness reads={[watched, mine]} what="The reviews" />;
}

function CurrentDetail() {
  const current = useCurrent();
  if (current === undefined) return null;
  const at = current.indexOf(":");
  const id = current.slice(at + 1);
  return current.startsWith("watched:") ? (
    <WatchedDetail key={id} id={id} />
  ) : (
    <MineDetail key={id} id={id} />
  );
}

type Which = "agent" | "act";

/** What an action answered: it stays until closed (D5). */
function ActionNotice({ of }: { readonly of: Which }) {
  const store = useReviews((s) => s[of]);
  const notice = useStore(store, (s) => s.notice);
  return (
    <Notice
      text={notice?.text}
      tone={notice?.tone ?? "error"}
      onClose={() => store.setState({ notice: undefined })}
    />
  );
}

/** Whether that kind of action waits for its answer. */
const useBusy = (of: Which): boolean =>
  useStore(
    useReviews((s) => s[of]),
    (s) => s.busy,
  );

/** A watched MR: its findings with their state and reason; Review or Re-review, Stop watching. */
function WatchedDetail({ id }: { readonly id: string }) {
  const w = useWatchedOne(id);
  if (!w) return null;
  const word = watchedWord(w.status);
  const news = watchEnded(w.status) ? undefined : newsText(w.news);
  return (
    <div className="review-detail" data-testid="review-detail">
      <ActionNotice of="agent" />
      <ActionNotice of="act" />
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
      {watchEnded(w.status) ? null : <WatchedActions review={w} news={news !== undefined} />}
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

function WatchedActions({ review: w, news }: { readonly review: ReviewView; readonly news: boolean }) {
  const busy = useBusy("agent");
  const api = useReviewsApi();
  const openRun = useOpenRun();
  const reviewing = w.status === "reviewing";
  return (
    <div className="actions">
      {w.status === "requested" ? (
        <Button variant="primary" disabled={busy} onClick={() => void api.getState().review(w)}>
          Review
        </Button>
      ) : (
        <Button
          className={news ? "primary" : ""}
          data-testid="rereview"
          disabled={busy || reviewing}
          title={reviewing ? "a review runs now" : undefined}
          onClick={() => void api.getState().rereview(w)}
        >
          Re-review
        </Button>
      )}
      {w.run && reviewing ? (
        <Button variant="ghost" onClick={() => openRun(w.run?.runId as string)}>
          Open the review
        </Button>
      ) : null}
      <Button variant="ghost" data-testid="unwatch" onClick={() => void api.getState().unwatch(w)}>
        Stop watching
      </Button>
    </div>
  );
}

/** My MR: its threads with the proposed replies; check which to send, then Send selected. */
function MineDetail({ id }: { readonly id: string }) {
  const m = useMineOne(id);
  if (!m) return null;
  return (
    <div className="review-detail" data-testid="mine-detail">
      <ActionNotice of="act" />
      <ActionNotice of="agent" />
      <h2>
        #{m.number} {m.title} <span className={`word ${reviewTone(mineWord(m))}`}>{mineWord(m)}</span>
      </h2>
      <MineHead request={m} />
      <div className="actions">
        <SendReplies request={m} />
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
              <ReplyToSend thread={t.id} author={t.author} reply={t.reply} />
            ) : t.reply ? (
              <div className="reply">
                <span className="dim">sent</span> {t.reply}
              </div>
            ) : null}
            {t.state !== "resolved" ? <ResolveThread request={m} thread={t.id} /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function MineHead({ request: m }: { readonly request: ReviewedRequest }) {
  const busy = useBusy("agent");
  const api = useReviewsApi();
  const openRun = useOpenRun();
  const repo = useReviewsDaemon((d) => d.repo);
  const run = useReviewsDaemon((d) => (m.runId ? d.run(m.runId, repo) : undefined));
  const fresh = m.fresh ?? 0;
  return (
    <div className="row">
      {fresh > 0 ? (
        <Button variant="primary" disabled={busy} onClick={() => void api.getState().analyse(m)}>
          Analyse {plural(fresh, "new thread")}
        </Button>
      ) : null}
      {m.runId ? (
        <>
          <span className="dim">answering run</span>{" "}
          <span>{run ? `${run.stage} · ${run.attention}` : "finished"}</span>
          <Button variant="ghost" onClick={() => openRun(m.runId as string)}>
            Open session
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** Every reply to send is checked until the person unchecks it. */
const checkedOf = (m: ReviewedRequest, unchecked: ReadonlySet<string>): ReadonlySet<string> =>
  new Set(m.threads.filter((t) => toSend(t) && !unchecked.has(t.id)).map((t) => t.id));

function SendReplies({ request: m }: { readonly request: ReviewedRequest }) {
  const unchecked = useReviews((s) => s.unchecked);
  const busy = useBusy("act");
  const api = useReviewsApi();
  const selection = sendSelection(m.threads, checkedOf(m, unchecked));
  return (
    <Button
      variant="primary"
      data-testid="send-replies"
      disabled={!selection || busy}
      onClick={() => void api.getState().sendReplies(m, selection?.only)}
    >
      {sendLabel(selection)}
    </Button>
  );
}

/** A proposed reply's checkbox: it hears only whether it is checked. */
function ReplyToSend({
  thread,
  author,
  reply,
}: {
  readonly thread: string;
  readonly author: string;
  readonly reply: string;
}) {
  const checked = useReviews((s) => !s.unchecked.has(thread));
  const toggleReply = useReviews((s) => s.toggleReply);
  return (
    <label className="reply">
      <input
        type="checkbox"
        aria-label={`send the reply to ${author || "the reviewer"}`}
        data-testid={`send-${thread}`}
        checked={checked}
        onChange={() => toggleReply(thread)}
      />{" "}
      <span className="dim">proposed reply</span> {reply}
    </label>
  );
}

function ResolveThread({
  request: m,
  thread,
}: {
  readonly request: ReviewedRequest;
  readonly thread: string;
}) {
  const api = useReviewsApi();
  return (
    <Button variant="ghost" onClick={() => void api.getState().resolve(m, thread)}>
      Resolve
    </Button>
  );
}
