/**
 * The place the route names, inside the main area: one screen per route, and the parts of the
 * settings above the screens that are settings (Options, System, App). Each screen reads the
 * daemon and acts by itself; it gets from the route only what the route says.
 */
import { BacklogScreen } from "../features/backlog/backlog-screen.tsx";
import { BoardScreen } from "../features/board/board-screen.tsx";
import { InboxScreen } from "../features/inbox/inbox-screen.tsx";
import { ReviewsScreen } from "../features/reviews/reviews-screen.tsx";
import { RunScreen } from "../features/runs/run-screen.tsx";
import { SettingsScreen } from "../features/settings/settings-screen.tsx";
import { OverviewScreen } from "../features/system/overview-screen.tsx";
import { WorkbenchScreen } from "../features/terminals/workbench-screen.tsx";
import { ThreadScreen } from "../features/threads/thread-screen.tsx";
import type { NeedRow } from "../shared/model/needs.ts";
import { type Route, routeHash } from "../shared/model/route.ts";

/** Settings holds the places that are not daily work: the System, the app's own settings. */
export function SettingsParts({ route }: { readonly route: Route }) {
  const part =
    route.screen === "overview"
      ? "system"
      : route.screen === "settings"
        ? "options"
        : route.screen === "app"
          ? "app"
          : undefined;
  if (!part) return null;
  return (
    <nav className="settings-parts run-tabs" aria-label="parts of the settings">
      {(
        [
          ["options", "Options", routeHash({ screen: "settings" })],
          ["system", "System", routeHash({ screen: "overview", tab: "daemon" })],
          ["app", "App", routeHash({ screen: "app" })],
        ] as const
      ).map(([id, label, href]) => (
        <a key={id} href={href} aria-current={part === id ? "page" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}

export function Screens({
  route,
  needs,
  picked,
}: {
  readonly route: Route;
  readonly needs: readonly NeedRow[];
  readonly picked: NeedRow | undefined;
}) {
  return (
    <>
      <SettingsParts route={route} />
      {route.screen === "inbox" ? <InboxScreen needs={needs} picked={picked} /> : null}
      {route.screen === "run" ? (
        <RunScreen runId={route.runId} tab={route.tab} pane={route.pane} file={route.file} />
      ) : null}
      {route.screen === "grid" ? (
        <WorkbenchScreen
          {...(route.pane ? { showPane: route.pane } : {})}
          task={route.task}
          session={route.session}
          group={route.group}
        />
      ) : null}
      {route.screen === "backlog" ? <BacklogScreen id={route.id} /> : null}
      {route.screen === "reviews" ? <ReviewsScreen id={route.id} /> : null}
      {route.screen === "overview" ? <OverviewScreen tab={route.tab} /> : null}
      {route.screen === "settings" ? <SettingsScreen /> : null}
      {route.screen === "thread" ? <ThreadScreen id={route.id} /> : null}
      {route.screen === "board" ? <BoardScreen task={route.task} /> : null}
    </>
  );
}
