/**
 * Overview: the daemon and what links the runs, in one place. "Daemon" is the figures of the
 * acceptance criteria, the open runs with who works on each, the hosts and the supervisor's
 * settings; "Dependencies" is the graph of parent and step runs, messages and shared files.
 */
import { RepoSelect } from "../components/common.tsx";
import { Tabs } from "../components/tabs.tsx";
import type { OverviewTab } from "../model.ts";
import { DaemonPanel } from "../overview/daemon-panel.tsx";
import { DependenciesPanel } from "../overview/dependencies-panel.tsx";

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
        ]}
      >
        <span className="spacer" />
        <RepoSelect />
      </Tabs>
      <div className="overview-body">
        {tab === "daemon" ? <DaemonPanel onOpenRun={onOpenRun} /> : <DependenciesPanel />}
      </div>
    </div>
  );
}
