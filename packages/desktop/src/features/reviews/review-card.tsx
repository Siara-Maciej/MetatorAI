/**
 * A review's card on Home (round 18), as the daemon composes it: asked to review an MR (Review ·
 * No), new commits or replies on a watched MR (Re-review), a new review on my MR (Analyse), every
 * finding fixed (approve: Yes · No). Each button is the request the daemon put on the card, sent
 * with the person's name; one that starts an agent shows its terminal at once. Approve reaches the
 * code host only after the person's Yes.
 */

import type { Envelope, ReviewCardView, ReviewStarted } from "../../shared/api/api.ts";
import { type Daemon, useDaemonStore } from "../../shared/daemon/daemon.tsx";
import type { Store } from "../../shared/daemon/daemon-store.ts";
import { routeHash } from "../../shared/model/route.ts";
import { navigate } from "../../shared/navigation.ts";
import { type ActionState, IDLE, runAction, sayIn } from "../../shared/state/action.ts";
import {
  ScopeProvider,
  type StoreApi,
  scopedStore,
  useScoped,
  useScopedApi,
} from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { actionBody, isNo, startedRoute } from "./model.ts";

/** A card's own action (ADR-0113): whether its request runs and what the daemon answered. */
const CardAction = scopedStore<ActionState & { readonly daemon: Store<Daemon> }, Store<Daemon>>(
  "ReviewCardAction",
  (daemon) => () => ({ ...IDLE, daemon }),
);

/**
 * Runs a request that may start an agent: the person's name first, then the request; once the
 * daemon says yes, the started agent's terminal shows. Resolves to what happened: refused, done
 * (nothing started), or shown (the app went to the terminal).
 */
async function startAgent(
  api: StoreApi<ActionState & { readonly daemon: Store<Daemon> }>,
  fn: (by: string) => Promise<Envelope<ReviewStarted>>,
): Promise<"refused" | "done" | "shown"> {
  let shown = false;
  const ok = await runAction(
    api,
    api.getState().daemon,
    async (by) => {
      const r = await fn(by);
      const to = r.ok ? startedRoute(r.data) : undefined;
      if (to) {
        shown = true;
        navigate(to);
      }
      return r;
    },
    { who: true },
  );
  return !ok ? "refused" : shown ? "shown" : "done";
}

export function ReviewCard({
  card,
  onDone,
}: {
  readonly card: ReviewCardView;
  /** A button's request went through and started nothing to show: Home goes on. */
  onDone(): void;
}) {
  const daemon = useDaemonStore();
  return (
    <ScopeProvider store={CardAction} init={daemon}>
      <article className="card review-card" aria-label="review card" data-testid={`review-card-${card.kind}`}>
        <h1>{card.prompt}</h1>
        <div className="dim">{card.title}</div>
        <CardNotice />
        <div className="actions">
          {card.actions.map((a, i) => (
            <CardButton key={a.label} action={a} primary={i === 0 && !isNo(a)} onDone={onDone} />
          ))}
          <a className="ghost link" href={routeHash({ screen: "reviews", id: card.review })}>
            Open in Reviews
          </a>
        </div>
      </article>
    </ScopeProvider>
  );
}

function CardNotice() {
  const notice = useScoped(CardAction, (s) => s.notice);
  const api = useScopedApi(CardAction);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={() => sayIn(api, undefined)} />;
}

/** One of the card's buttons: the request the daemon put on the card, sent with the person's name. */
function CardButton({
  action,
  primary,
  onDone,
}: {
  readonly action: ReviewCardView["actions"][number];
  readonly primary: boolean;
  onDone(): void;
}) {
  const busy = useScoped(CardAction, (s) => s.busy);
  const api = useScopedApi(CardAction);
  return (
    <Button
      className={primary ? "primary" : ""}
      disabled={busy}
      onClick={() =>
        void startAgent(api, (by) =>
          api.getState().daemon.getState().client.cardAction(action.path, actionBody(action, by)),
        ).then((r) => {
          if (r === "done") onDone();
        })
      }
    >
      {action.label}
    </Button>
  );
}
