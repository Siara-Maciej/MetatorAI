/** Screen 6: the new-session dialog over the inbox; the footer shows the `metator run init` it amounts to. */
import { useEffect, useState } from "react";
import type { Workflow } from "../api.ts";
import { useDaemon } from "../daemon.tsx";

export function NewSessionDialog({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(runId: string, attach: boolean): void;
}) {
  const { client, repos, runs, me, setMe } = useDaemon();
  const [repo, setRepo] = useState(repos[0]?.name ?? "");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [wipLimit, setWipLimit] = useState(4);
  const [workflow, setWorkflow] = useState("");
  const [task, setTask] = useState("");
  const [host, setHost] = useState("");
  const [autonomy, setAutonomy] = useState("L0");
  const [worktree, setWorktree] = useState(true);
  const [parent, setParent] = useState("");
  const [name, setName] = useState(me);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void (async () => {
      const [w, s] = await Promise.all([
        client.workflows(repo || undefined),
        client.supervisor(repo || undefined),
      ]);
      if (w.ok && w.data) {
        setWorkflows(w.data.workflows);
        setWorkflow((cur) => cur || w.data?.workflows[0]?.id || "");
      }
      if (s.ok && s.data) {
        setHosts([...s.data.hosts]);
        setHost(
          (cur) =>
            cur || s.data?.policy.hostOrder.find((h) => s.data?.hosts.includes(h)) || s.data?.hosts[0] || "",
        );
        setWipLimit(s.data.policy.wipLimit);
      }
    })();
  }, [client, repo]);
  const waiting = runs.filter((r) => r.attention === "you").length;
  const command = `metator run init --workflow ${workflow || "<workflow>"} --task ${JSON.stringify(task || "<task>")}${autonomy !== "L0" ? ` --autonomy ${autonomy}` : ""}${worktree ? " --worktree" : ""}${parent ? ` --parent ${parent}` : ""}${host ? ` && metator run drive --host ${host} --detach` : ""}`;
  const create = async (andAttach: boolean) => {
    if (!workflow || !task.trim()) {
      setError("a workflow and a task are needed");
      return;
    }
    setBusy(true);
    if (name.trim()) setMe(name.trim());
    const r = await client.createRun(
      {
        workflow,
        task: task.trim(),
        autonomy,
        worktree,
        ...(parent ? { parent } : {}),
        ...(host ? { drive: host } : {}),
      },
      repo || undefined,
    );
    setBusy(false);
    if (!r.ok || !r.data) {
      setError(r.error?.message ?? "the run was not created");
      return;
    }
    if (r.data.drive?.error) setError(`created, but the drive did not start: ${r.data.drive.error}`);
    onCreated(r.data.run.runId, andAttach);
  };
  return (
    <div className="backdrop">
      <div className="dialog" role="dialog" aria-label="new session">
        <h2>New session</h2>
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
            placeholder="what to do, in one or two sentences; intake asks (mt-grill) when it is ambiguous"
          />
        </label>
        <label className="field">
          <span>Host</span>
          <select value={host} onChange={(e) => setHost(e.target.value)}>
            <option value="">create only, drive later</option>
            {hosts.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Autonomy</span>
          <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
            <option value="L0">L0 · every gate asks</option>
            <option value="L1">L1 · gates pass on green</option>
          </select>
        </label>
        <label className="field">
          <span>Workspace</span>
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
              .filter((r) => r.status === "active" && (r.repo ?? "") === (repo ?? ""))
              .map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.task}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="who approves" />
        </label>
        {waiting >= wipLimit ? (
          <div className="warn">
            Attention budget: {waiting} sessions already wait for you (limit {wipLimit}). A new one queues
            behind them.
          </div>
        ) : null}
        {error ? <div className="banner">{error}</div> : null}
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
      </div>
    </div>
  );
}
