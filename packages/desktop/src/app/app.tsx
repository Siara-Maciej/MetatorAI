/**
 * The shell: a thin top bar, the sidebar that is the whole dashboard (what needs you, the chats
 * with their tasks, the other places, "+ New chat"), and the place the hash route names. It only
 * composes: each part reads the daemon and acts by itself (ADR-0109).
 */

import { useState } from "react";
import { useNeeds } from "../features/inbox/use-needs.ts";
import { AddRepoScreen } from "../features/repos/add-repo-screen.tsx";
import { ContainerDown } from "../features/repos/container-down.tsx";
import { FirstRun } from "../features/repos/first-run.tsx";
import { shellView } from "../features/repos/repos.ts";
import { ReposProvider, useRepos } from "../features/repos/repos-context.tsx";
import { NewSessionDialog } from "../features/runs/new-session.tsx";
import { useOpenRun } from "../features/runs/open-run.ts";
import { AppSettings } from "../features/settings/app-settings.tsx";
import { DaemonProvider, useDaemon } from "../shared/daemon/daemon.tsx";
import { useKeptFlag } from "../shared/hooks.ts";
import { keyMapOf } from "../shared/model/keys.ts";
import { cardNeeds, pickedNeed } from "../shared/model/needs.ts";
import { routeHash } from "../shared/model/route.ts";
import { closeHelp, closeNewRun, useOverlays } from "../shared/overlays.ts";
import { HelpOverlay } from "./help-overlay.tsx";
import { NoDaemon } from "./no-daemon.tsx";
import { ScreenBoundary } from "./screen-boundary.tsx";
import { Screens, SettingsParts } from "./screens.tsx";
import { useBackAfterAway, useFollowedThreads, useQuestionNotifications } from "./shell-effects.ts";
import { ShellNotice } from "./shell-notice.tsx";
import { Sidebar } from "./sidebar/sidebar.tsx";
import { TopBar } from "./top-bar.tsx";
import { useRoute } from "./use-route.ts";
import { useShellKeys } from "./use-shell-keys.ts";

export const App = () => (
  <DaemonProvider>
    <ReposProvider>
      <Shell />
    </ReposProvider>
  </DaemonProvider>
);

function Shell() {
  const { down, options, startError, starting } = useDaemon("down", "options", "startError", "starting");
  const repos = useRepos();
  // Below about 1000 px the sidebar is a drawer behind a button of the top bar; a move closes it.
  const [drawer, setDrawer] = useState(false);
  const route = useRoute(() => setDrawer(false));
  const needs = useNeeds();
  const picked = route.screen === "inbox" ? pickedNeed(cardNeeds(needs), route.pick) : undefined;
  const { help, newRun } = useOverlays();
  const openRun = useOpenRun();
  useQuestionNotifications();
  useBackAfterAway(route);
  useFollowedThreads(route);
  useShellKeys(route, needs, picked, () => setDrawer(false));
  // What the main area holds instead of the daemon's screens (round 20): the first run, Add
  // repository, the app's settings, or the panel that says the daemon is not there.
  const view = shellView({
    commands: repos.commands !== undefined,
    known: repos.known,
    down,
    screen: route.screen,
    current: repos.current,
    startFailed: startError !== undefined && !starting,
  });
  // With no repository yet there is nothing for the sidebar: the first run and Add stand alone.
  const solo = repos.commands !== undefined && repos.known?.length === 0;
  // The sidebar folded to its narrow version (round 22), kept by the window.
  const [sideNarrow, setSideNarrow] = useKeptFlag("metator.sidebar.narrow", false);
  return (
    <div
      className={`shell${drawer ? " panel-open" : ""}${solo ? " solo" : ""}${sideNarrow ? " side-narrow" : ""}`}
    >
      <TopBar solo={solo} needs={needs.length} drawerOpen={drawer} onDrawer={() => setDrawer(!drawer)} />
      {solo ? null : <Sidebar route={route} needs={needs} narrow={sideNarrow} onNarrow={setSideNarrow} />}
      <main className="content">
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
      </main>
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
    </div>
  );
}
