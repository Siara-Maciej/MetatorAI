/**
 * The shell: a thin top bar, the sidebar that is the whole dashboard (what needs you, the chats
 * with their tasks, the other places, "+ New chat"), and the place the hash route names. It only
 * composes: each part reads the daemon, the route and the shell's state it draws, and acts by
 * itself (ADR-0109, ADR-0113), so a move draws the main area and the sidebar's current row, not
 * the top bar.
 */

import type { ReactNode } from "react";
import { useNeeds } from "../features/inbox/use-needs.ts";
import { AddRepoScreen } from "../features/repos/add-repo-screen.tsx";
import { ContainerDown } from "../features/repos/container-down.tsx";
import { FirstRun } from "../features/repos/first-run.tsx";
import { shellView } from "../features/repos/repos.ts";
import { ReposProvider, useReposOf } from "../features/repos/repos-context.tsx";
import { NewSessionDialog } from "../features/runs/new-session.tsx";
import { useOpenRun } from "../features/runs/open-run.ts";
import { AppSettings } from "../features/settings/app-settings.tsx";
import { DaemonProvider, useDaemon } from "../shared/daemon/daemon.tsx";
import { useKeptFlag } from "../shared/hooks.ts";
import { keyMapOf } from "../shared/model/keys.ts";
import { pickedNeed } from "../shared/model/needs.ts";
import { routeHash } from "../shared/model/route.ts";
import { closeHelp, closeNewRun, useOverlays } from "../shared/overlays.ts";
import { HelpOverlay } from "./help-overlay.tsx";
import { NoDaemon } from "./no-daemon.tsx";
import { ScreenBoundary } from "./screen-boundary.tsx";
import { Screens, SettingsParts } from "./screens.tsx";
import { useBackAfterAway, useFollowedThreads, useQuestionNotifications } from "./shell-effects.ts";
import { ShellNotice } from "./shell-notice.tsx";
import { closeDrawer, toggleDrawer, useDrawerOpen } from "./shell-state.ts";
import { Sidebar } from "./sidebar/sidebar.tsx";
import { TopBar } from "./top-bar.tsx";
import { useRoute, useRouteListener } from "./use-route.ts";
import { useShellKeys } from "./use-shell-keys.ts";

/** The sidebar folded to its narrow version (round 22), kept by the window. */
const SIDE_NARROW = "metator.sidebar.narrow";

export const App = () => (
  <DaemonProvider>
    <ReposProvider>
      <Shell />
    </ReposProvider>
  </DaemonProvider>
);

/** The shell only lays its parts out; none of them draws for another's change. */
function Shell() {
  return (
    <ShellFrame>
      <ShellTop />
      <ShellSide />
      <main className="content">
        <ShellMain />
      </main>
      <ShellOverlays />
      {/* Last: its effects run after the parts' own, as the shell's did. */}
      <ShellEffects />
    </ShellFrame>
  );
}

/** With no repository yet there is nothing for the sidebar: the first run and Add stand alone. */
const useSolo = (): boolean => useReposOf((r) => r.commands !== undefined && r.known?.length === 0);

function ShellFrame({ children }: { readonly children: ReactNode }) {
  // Below about 1000 px the sidebar is a drawer behind a button of the top bar; a move closes it.
  const drawer = useDrawerOpen();
  const solo = useSolo();
  const [sideNarrow] = useKeptFlag(SIDE_NARROW, false);
  return (
    <div
      className={`shell${drawer ? " panel-open" : ""}${solo ? " solo" : ""}${sideNarrow ? " side-narrow" : ""}`}
    >
      {children}
    </div>
  );
}

/** What the shell does on its own: notifications, the keys, a move that closes the drawer. */
function ShellEffects() {
  useRouteListener(closeDrawer);
  const route = useRoute();
  const needs = useNeeds();
  const picked = route.screen === "inbox" ? pickedNeed(needs, route.pick) : undefined;
  useQuestionNotifications();
  useBackAfterAway(route);
  useFollowedThreads(route);
  useShellKeys(route, needs, picked, closeDrawer);
  return null;
}

function ShellTop() {
  const solo = useSolo();
  const drawer = useDrawerOpen();
  const needs = useNeeds().length;
  return <TopBar solo={solo} needs={needs} drawerOpen={drawer} onDrawer={toggleDrawer} />;
}

function ShellSide() {
  const solo = useSolo();
  const [sideNarrow, setSideNarrow] = useKeptFlag(SIDE_NARROW, false);
  return solo ? null : <Sidebar narrow={sideNarrow} onNarrow={setSideNarrow} />;
}

/**
 * What the main area holds instead of the daemon's screens (round 20): the first run, Add
 * repository, the app's settings, or the panel that says the daemon is not there.
 */
function ShellMain() {
  const { down, startError, starting } = useDaemon("down", "startError", "starting");
  const commands = useReposOf((r) => r.commands !== undefined);
  const known = useReposOf((r) => r.known);
  const current = useReposOf((r) => r.current);
  const route = useRoute();
  const needs = useNeeds();
  const picked = route.screen === "inbox" ? pickedNeed(needs, route.pick) : undefined;
  const view = shellView({
    commands,
    known,
    down,
    screen: route.screen,
    current,
    startFailed: startError !== undefined && !starting,
  });
  return (
    <>
      <ShellNotice shown={view === "screens"} />
      {view === "first-run" ? <FirstRun /> : null}
      {view === "add" ? <AddRepoScreen /> : null}
      {view === "app-settings" ? (
        <>
          <SettingsParts route={route} />
          <AppSettings />
        </>
      ) : null}
      {view === "no-daemon" ? <NoDaemon /> : null}
      {view === "container-down" ? <ContainerDown /> : null}
      {view === "screens" ? (
        <ScreenBoundary place={routeHash(route)}>
          <Screens route={route} needs={needs} picked={picked} />
        </ScreenBoundary>
      ) : null}
    </>
  );
}

function ShellOverlays() {
  const { down, options } = useDaemon("down", "options");
  const { help, newRun } = useOverlays();
  const openRun = useOpenRun();
  return (
    <>
      {help ? <HelpOverlay keymap={keyMapOf(options)} onClose={closeHelp} /> : null}
      {newRun && !down ? (
        <NewSessionDialog
          onClose={closeNewRun}
          onCreated={(runId, attach) => {
            closeNewRun();
            if (attach) openRun(runId, true);
          }}
        />
      ) : null}
    </>
  );
}
