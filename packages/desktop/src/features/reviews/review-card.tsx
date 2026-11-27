/**
 * A review's card on Home (round 18), as the daemon composes it: asked to review an MR (Review ·
 * No), new commits or replies on a watched MR (Re-review), a new review on my MR (Analyse), every
 * finding fixed (approve: Yes · No). Each button is the request the daemon put on the card, sent
 * with the person's name; one that starts an agent shows its terminal at once. Approve reaches the
 * code host only after the person's Yes.
 */

import type { Envelope, ReviewCardView, ReviewStarted } from "../../shared/api/api.ts";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { useAction } from "../../shared/hooks.ts";
import { routeHash } from "../../shared/model/route.ts";
import { navigate } from "../../shared/navigation.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { actionBody, isNo, startedRoute } from "./model.ts";

/**
 * Runs a request that may start an agent: the person's name first, then the request; once the
 * daemon says yes, the started agent's terminal shows. Resolves to what happened: refused, done
 * (nothing started), or shown (the app went to the terminal).
 */
function useStartAgent(reload?: () => Promise<unknown> | unknown) {
  const action = useAction(reload);
  const start = async (
    fn: (by: string) => Promise<Envelope<ReviewStarted>>,
  ): Promise<"refused" | "done" | "shown"> => {
    let shown = false;
    const ok = await action.run(
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
  };
  return { start, action };
}

export function ReviewCard({
  card,
  onDone,
}: {
  readonly card: ReviewCardView;
  /** A button's request went through and started nothing to show: Home goes on. */
  onDone(): void;
}) {
  const { client } = useDaemon("client");
  const { start, action } = useStartAgent();
  return (
    <article className="card review-card" aria-label="review card" data-testid={`review-card-${card.kind}`}>
      <h1>{card.prompt}</h1>
      <div className="dim">{card.title}</div>
      <Notice {...action.notice} />
      <div className="actions">
        {card.actions.map((a, i) => (
          <Button
            key={a.label}
            className={i === 0 && !isNo(a) ? "primary" : ""}
            disabled={action.busy}
            onClick={() =>
              void start((by) => client.cardAction(a.path, actionBody(a, by))).then((r) => {
                if (r === "done") onDone();
              })
            }
          >
            {a.label}
          </Button>
        ))}
        <a className="ghost link" href={routeHash({ screen: "reviews", id: card.review })}>
          Open in Reviews
        </a>
      </div>
    </article>
  );
}
