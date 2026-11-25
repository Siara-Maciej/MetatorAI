/**
 * The thin top bar: the repository switcher, the drawer's button (below about 1000 px the sidebar
 * is a drawer), the keys' help, the person's name and the connection.
 */
import { RepoSwitcher } from "../features/repos/repo-switcher.tsx";
import { useDaemon } from "../shared/daemon/daemon.tsx";
import { folderLabel } from "../shared/model/places.ts";
import { openRuns } from "../shared/model/runs.ts";
import { openHelp } from "../shared/overlays.ts";
import { Button } from "../ui/button.tsx";

export function TopBar({
  solo,
  needs,
  drawerOpen,
  onDrawer,
}: {
  /** No repository yet: only the logo and the help. */
  readonly solo: boolean;
  /** How many things need the person. */
  readonly needs: number;
  readonly drawerOpen: boolean;
  onDrawer(): void;
}) {
  const { repos, runs, me, connected, down, changeName } = useDaemon(
    "repos",
    "runs",
    "me",
    "connected",
    "down",
    "changeName",
  );
  return (
    <header className="topbar">
      <span className="logo">MetatorAI</span>
      {/* The folder: its repositories, counted once however many worktrees each has. */}
      {solo ? null : <RepoSwitcher served={folderLabel(repos)} />}
      <Button className="panel-toggle" aria-expanded={drawerOpen} onClick={onDrawer}>
        Runs · {openRuns(runs).length}
        {needs > 0 ? ` · ${needs} need you` : ""}
      </Button>
      <span className="spacer" />
      <Button variant="ghost" title="the keys of the app" aria-label="keyboard help" onClick={openHelp}>
        ?
      </Button>
      {solo ? null : (
        <>
          <Button
            variant="ghost"
            className="who"
            title="Your name goes next to every answer you give. Click to change it."
            onClick={changeName}
          >
            {me ? `you: ${me}` : "set your name"}
          </Button>
          <span className={`conn ${connected ? "green" : "red"}`} data-testid="connection">
            {connected ? "connected" : down ? "no daemon" : "connecting…"}
          </span>
        </>
      )}
    </header>
  );
}
