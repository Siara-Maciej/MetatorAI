/**
 * What a route names that the daemon does not have (a run, a chat): said once the daemon was
 * asked (`useFound`), with the way back, instead of "on its way" forever.
 */
import { routeHash } from "../model/route.ts";

export function NotFound({ what, id }: { readonly what: string; readonly id: string }) {
  return (
    <div className="empty" data-testid="not-found">
      <h2>No such {what}</h2>
      <p>
        The daemon has no {what} <span className="mono">{id}</span>: it was never made here, or the link is
        from another repository or daemon.
      </p>
      <p>
        <a href={routeHash({ screen: "inbox" })}>Back to Home</a>
      </p>
    </div>
  );
}
