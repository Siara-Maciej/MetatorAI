/**
 * Overview: the daemon and what links the runs, in one place. "Daemon" is the figures of the
 * acceptance criteria, the open runs with who works on each, the hosts and the supervisor's
 * settings; "Dependencies" is the graph of parent and step runs, messages and shared files.
 */

import { RepoSelect } from "../../shared/components/repo-select.tsx";
import { type OverviewTab, routeHash } from "../../shared/model/route.ts";
import { Tabs } from "../../ui/tabs.tsx";
import { DaemonPanel } from "./daemon-panel.tsx";
import { DependenciesPanel } from "./dependencies-panel.tsx";
import { SystemPanel } from "./system-panel.tsx";

export function OverviewScreen({
  tab,
  onTab,
  onOpenRun,
}: {
  readonly tab: OverviewTab;
  onTab(tab: OverviewTab): void;
  onOpenRun(runId: string): void;
}) {
  return (
    <div className="overview" data-testid="overview">
      <Tabs
        label="parts of the overview"
        current={tab}
        onSelect={(id) => onTab(id)}
        items={[
          { id: "daemon", label: "Daemon" },
          { id: "dependencies", label: "Dependencies" },
          { id: "system", label: "System" },
        ]}
      >
        <a className="board-link" href={routeHash({ screen: "board" })}>
          Board ›
        </a>
        <span className="spacer" />
        <RepoSelect />
      </Tabs>
      <div className="overview-body">
        {tab === "daemon" ? (
          <DaemonPanel onOpenRun={onOpenRun} />
        ) : tab === "system" ? (
          <SystemPanel onOpenRun={onOpenRun} />
        ) : (
          <DependenciesPanel onOpenRun={onOpenRun} />
        )}
      </div>
    </div>
  );
}
