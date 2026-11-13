/** The new-run form, a dialog; the footer shows the `metator run init` it amounts to. */
import { useState } from "react";
import type { Workflow } from "../api.ts";
import { Notice } from "../components/common.tsx";
import { Modal } from "../components/modal.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import {
  autonomyLabel,
  autonomyLevels,
  type HostStatus,
  hostChoice,
  noHostText,
  refusedForDirtyTree,
  START_FROM_COMMIT,
  sameRepo,
  workflowChoice,
} from "../model.ts";

export function NewSessionDialog({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(runId: string, attach: boolean): void;
}) {
  const { client, repos, repo: listRepo, runs } = useDaemon();
  const [repo, setRepo] = useState(listRepo ?? "");
  // What the form offers, asked once per repository: its workflows, its hosts and its limit.
  const offered = usePolled(
    `new-session:${repo}`,
    async () => {
      const [w, s] = await Promise.all([
        client.workflows(repo || undefined),
        client.supervisor(repo || undefined),
      ]);
      return { ok: true, data: { workflows: w.data?.workflows ?? [], supervisor: s.data } };
    },
    0,
  );
  const workflows: readonly Workflow[] = offered.data?.workflows ?? [];
  const supervisor = offered.data?.supervisor;
  // An older daemon does not say what is installed: every host it knows is offered.
  const hosts: readonly HostStatus[] | undefined = supervisor
    ? (supervisor.hostStatus ?? supervisor.hosts.map((id) => ({ id, installed: true })))
    : undefined;
  const wipLimit = supervisor?.policy.wipLimit ?? 4;
  // A feature is what a first task usually is: the form starts there, not at the first of the alphabet.
  const [wantedWorkflow, setWorkflow] = useState<string>();
  const workflow =
    workflowChoice(
      workflows.map((w) => w.id),
      wantedWorkflow,
    ) ?? "";
  const [task, setTask] = useState("");
  // The first host of the order that is installed (D1), until the person chooses; none installed: create only.
  const [wantedHost, setHost] = useState<string>();
  const host =
    wantedHost !== undefined && (wantedHost === "" || hosts?.some((h) => h.id === wantedHost && h.installed))
      ? wantedHost
      : ((hosts ? hostChoice(supervisor?.policy.hostOrder ?? [], hosts) : undefined) ?? "");
  // Only the levels the chosen workflow runs at are offered; a level it does not list gives way to its first.
  const levels = autonomyLevels(workflows.find((w) => w.id === workflow));
  const [wantedAutonomy, setAutonomy] = useState("L0");
  const autonomy = levels.includes(wantedAutonomy) ? wantedAutonomy : (levels[0] ?? "L0");
  const [worktree, setWorktree] = useState(true);
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** The last start was refused for uncommitted changes: how to start without them. */
  const [dirty, setDirty] = useState<{ andAttach: boolean }>();
  const waiting = runs.filter((r) => r.attention === "you").length;
  const command = `metator run init --workflow ${workflow || "<workflow>"} --task ${JSON.stringify(task || "<task>")}${autonomy !== "L0" ? ` --autonomy ${autonomy}` : ""}${worktree ? " --worktree" : ""}${parent ? ` --parent ${parent}` : ""}${host ? ` && metator run drive --host ${host} --detach` : ""}`;
  const create = async (andAttach: boolean, allowDirty = false) => {
    setDirty(undefined);
    if (!workflow || !task.trim()) {
      setError("a workflow and a task are needed");
      return;
    }
    setBusy(true);
    const r = await client.createRun(
      {
        workflow,
        task: task.trim(),
        autonomy,
        worktree,
        ...(parent ? { parent } : {}),
        ...(host ? { drive: host } : {}),
        ...(allowDirty ? { allowDirty: true } : {}),
      },
      repo || undefined,
    );
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.error?.message ?? "the run was not created");
      if (refusedForDirtyTree(r.error)) setDirty({ andAttach });
      return;
    }
    // The run exists but nothing drives it: the dialog stays to say so (the run is in the panel).
    if (r.data.drive?.error) {
      setError(
        `The run was created, but its agent did not start: ${r.data.drive.error} Open it from the panel on the left.`,
      );
      return;
    }
    onCreated(r.data.run.runId, andAttach);
  };
  return (
    <Modal label="new run" onClose={onClose}>
      <h2>New run</h2>
      {repos.length > 0 ? (
        <label className="field">
          <span>Repository</span>
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="field">
        <span>Workflow</span>
        <select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.id}
              {w.description ? ` · ${w.description}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Task</span>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="what to do, in one or two sentences; the agent asks when it is ambiguous"
        />
      </label>
      <label className="field">
        <span>AI host</span>
        <select value={host} onChange={(e) => setHost(e.target.value)}>
          <option value="">create only, start the agent later</option>
          {(hosts ?? []).map((h) => (
            <option key={h.id} value={h.id} disabled={!h.installed}>
              {h.id}
              {h.installed ? "" : " (not installed)"}
            </option>
          ))}
        </select>
      </label>
      {hosts && !hosts.some((h) => h.installed) ? (
        <div className="warn" data-testid="no-host">
          {noHostText(hosts)} Until then the run can only be created; no agent works on it.
        </div>
      ) : null}
      <label className="field">
        <span>Autonomy</span>
        <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
          {levels.map((level) => (
            <option key={level} value={level}>
              {autonomyLabel(level)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Worktree</span>
        <span>
          <label>
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> a
            worktree with its own ports (else the main checkout)
          </label>
        </span>
      </label>
      <label className="field">
        <span>Parent run</span>
        <select value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">none (standalone)</option>
          {runs
            .filter((r) => r.status === "active" && sameRepo(r.repo, repo || undefined))
            .map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.task}
              </option>
            ))}
        </select>
      </label>
      {waiting >= wipLimit ? (
        <div className="warn">
          Attention budget: {waiting} runs already wait for you (limit {wipLimit}). A new one queues behind
          them.
        </div>
      ) : null}
      <Notice
        text={error}
        action={
          dirty ? { label: START_FROM_COMMIT, run: () => void create(dirty.andAttach, true) } : undefined
        }
        onClose={() => {
          setError(undefined);
          setDirty(undefined);
        }}
      />
      <div className="foot">
        <code>{command}</code>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={() => void create(false)}>
          Create in background
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void create(true)}>
          Create and attach
        </button>
      </div>
    </Modal>
  );
}
