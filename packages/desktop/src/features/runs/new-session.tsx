/**
 * The new-run form, a dialog; the footer shows the `metator run new` it amounts to.
 *
 * The dialog only lays its parts out (ADR-0113): what it keeps is the New run store
 * (`new-run-state.ts`), made when the dialog opens; each field reads only its own value, so typing
 * the task draws the task field and the command line again, not the form.
 */

import type { DaemonClient, Workflow } from "../../shared/api/api.ts";
import { useDaemon, useDaemonStore, usePolled, usePolledSelect } from "../../shared/daemon/daemon.tsx";
import { placeLabel, sameRepo } from "../../shared/model/places.ts";
import { type HostStatus, hostChoice, noHostText, workflowChoice } from "../../shared/model/runs.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { Notice } from "../../ui/notice.tsx";
import { autonomyLabel, autonomyLevels, formOffer, START_FROM_COMMIT } from "./model.ts";
import { NewRun, type RunChoice, useNewRun, useNewRunApi } from "./new-run-state.ts";

type Created = (runId: string, attach: boolean) => void;

export function NewSessionDialog({ onClose, onCreated }: { onClose(): void; onCreated: Created }) {
  const daemon = useDaemonStore();
  return (
    <ScopeProvider store={NewRun} init={{ daemon }}>
      <Modal label="new run" onClose={onClose}>
        <h2>New run</h2>
        <RepoField />
        <WorkflowField />
        <TaskField />
        <HostField />
        <NoHostWarning />
        <AutonomyField />
        <WorktreeField />
        <ParentField />
        <BudgetWarning />
        <ReadErrorNotice />
        <CreateNotice onCreated={onCreated} />
        <div className="foot">
          <Command />
          <Button onClick={onClose}>Cancel</Button>
          <CreateButton andAttach={false} onCreated={onCreated} />
          <CreateButton andAttach onCreated={onCreated} />
        </div>
      </Modal>
    </ScopeProvider>
  );
}

/* ---------- what the form offers ---------- */

type Offer = NonNullable<ReturnType<typeof formOffer>["data"]>;

const NO_WORKFLOWS: readonly Workflow[] = [];

/**
 * What the form offers, asked once per repository: its workflows, its hosts and its limit, or
 * `select`'s part of it. Workflows that could not be read are said, and nothing can be created
 * until they are.
 */
function useOffer<R>(select: (offer: Offer | undefined) => R): R {
  const { client } = useDaemon("client");
  const repo = useNewRun((s) => s.repo);
  return usePolledSelect(`new-session:${repo}`, () => offerOf(client, repo), 0, select);
}

const offerOf = async (client: DaemonClient, repo: string) => {
  const [w, s] = await Promise.all([
    client.workflows(repo || undefined),
    client.supervisor(repo || undefined),
  ]);
  return formOffer(w, s);
};

/** The hosts the form offers; an older daemon does not say what is installed: every host it knows. */
const hostsOf = (offer: Offer | undefined): readonly HostStatus[] | undefined => {
  const supervisor = offer?.supervisor;
  return supervisor
    ? (supervisor.hostStatus ?? supervisor.hosts.map((id) => ({ id, installed: true })))
    : undefined;
};

/** A feature is what a first task usually is: the form starts there, not at the first of the alphabet. */
function useWorkflow(): string {
  const wanted = useNewRun((s) => s.wantedWorkflow);
  return useOffer(
    (o) =>
      workflowChoice(
        (o?.workflows ?? NO_WORKFLOWS).map((w) => w.id),
        wanted,
      ) ?? "",
  );
}

/** The first host of the order that is installed (D1), until the person chooses; none installed: create only. */
function useHost(): string {
  const wanted = useNewRun((s) => s.wantedHost);
  return useOffer((o) => {
    const hosts = hostsOf(o);
    return wanted !== undefined && (wanted === "" || hosts?.some((h) => h.id === wanted && h.installed))
      ? wanted
      : ((hosts ? hostChoice(o?.supervisor?.policy.hostOrder ?? [], hosts) : undefined) ?? "");
  });
}

/** Only the levels the chosen workflow runs at are offered. */
function useLevels(workflow: string): readonly string[] {
  return useOffer((o) => autonomyLevels(o?.workflows.find((w) => w.id === workflow)));
}

/** A level the workflow does not list gives way to its first. */
function useAutonomy(): string {
  const levels = useLevels(useWorkflow());
  const wanted = useNewRun((s) => s.wantedAutonomy);
  return levels.includes(wanted) ? wanted : (levels[0] ?? "L0");
}

/** What a create sends now: read by the buttons, which draw again only when one of these changed. */
function useChoice(): RunChoice {
  return { workflow: useWorkflow(), host: useHost(), autonomy: useAutonomy() };
}

/* ---------- the fields ---------- */

function RepoField() {
  const { repos } = useDaemon("repos");
  const repo = useNewRun((s) => s.repo);
  const setRepo = useNewRun((s) => s.setRepo);
  return repos.length > 0 ? (
    <label className="field">
      <span>Repository</span>
      <select aria-label="Start in repository" value={repo} onChange={(e) => setRepo(e.target.value)}>
        {repos.map((r) => (
          <option key={r.name} value={r.name}>
            {placeLabel(r)}
          </option>
        ))}
      </select>
    </label>
  ) : null;
}

function WorkflowField() {
  const workflows = useOffer((o) => o?.workflows ?? NO_WORKFLOWS);
  const workflow = useWorkflow();
  const setWorkflow = useNewRun((s) => s.setWorkflow);
  return (
    <label className="field">
      <span>Workflow</span>
      <select aria-label="Workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
        {workflows.map((w) => (
          <option key={w.id} value={w.id}>
            {w.id}
            {w.description ? ` · ${w.description}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TaskField() {
  const task = useNewRun((s) => s.task);
  const setTask = useNewRun((s) => s.setTask);
  return (
    <label className="field">
      <span>Task</span>
      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder="what to do, in one or two sentences; the agent asks when it is ambiguous"
      />
    </label>
  );
}

function HostField() {
  const hosts = useOffer(hostsOf);
  const host = useHost();
  const setHost = useNewRun((s) => s.setHost);
  return (
    <label className="field">
      <span>AI host</span>
      <select aria-label="AI host" value={host} onChange={(e) => setHost(e.target.value)}>
        <option value="">create only, start the agent later</option>
        {(hosts ?? []).map((h) => (
          <option key={h.id} value={h.id} disabled={!h.installed}>
            {h.id}
            {h.installed ? "" : " (not installed)"}
          </option>
        ))}
      </select>
    </label>
  );
}

function NoHostWarning() {
  const hosts = useOffer(hostsOf);
  return hosts && !hosts.some((h) => h.installed) ? (
    <div className="warn" data-testid="no-host">
      {noHostText(hosts)} Until then the run can only be created; no agent works on it.
    </div>
  ) : null;
}

function AutonomyField() {
  const levels = useLevels(useWorkflow());
  const autonomy = useAutonomy();
  const setAutonomy = useNewRun((s) => s.setAutonomy);
  return (
    <label className="field">
      <span>Autonomy</span>
      <select aria-label="Autonomy" value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
        {levels.map((level) => (
          <option key={level} value={level}>
            {autonomyLabel(level)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function WorktreeField() {
  const worktree = useNewRun((s) => s.worktree);
  const setWorktree = useNewRun((s) => s.setWorktree);
  return (
    <label className="field">
      <span>Worktree</span>
      <span>
        <label>
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> a
          worktree with its own ports (else the main checkout)
        </label>
      </span>
    </label>
  );
}

function ParentField() {
  const { runs } = useDaemon("runs");
  const repo = useNewRun((s) => s.repo);
  const parent = useNewRun((s) => s.parent);
  const setParent = useNewRun((s) => s.setParent);
  return (
    <label className="field">
      <span>Parent run</span>
      <select aria-label="Parent run" value={parent} onChange={(e) => setParent(e.target.value)}>
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
  );
}

function BudgetWarning() {
  const { runs } = useDaemon("runs");
  const wipLimit = useOffer((o) => o?.supervisor?.policy.wipLimit ?? 4);
  const waiting = runs.filter((r) => r.attention === "you").length;
  return waiting >= wipLimit ? (
    <div className="warn">
      Attention budget: {waiting} runs already wait for you (limit {wipLimit}). A new one queues behind them.
    </div>
  ) : null;
}

/** The offer's read failure, until closed; another failure shows again. */
function ReadErrorNotice() {
  const { client } = useDaemon("client");
  const repo = useNewRun((s) => s.repo);
  const hiddenError = useNewRun((s) => s.hiddenError);
  const hideError = useNewRun((s) => s.hideError);
  const offered = usePolled(`new-session:${repo}`, () => offerOf(client, repo), 0);
  const readError = offered.data === undefined && offered.error !== hiddenError ? offered.error : undefined;
  return (
    <Notice
      text={readError}
      action={{ label: "Try again", run: () => void offered.reload() }}
      onClose={() => hideError(readError)}
    />
  );
}

/* ---------- creating ---------- */

/** What the last create answered; a refusal for uncommitted changes offers the create from the last commit. */
function CreateNotice({ onCreated }: { readonly onCreated: Created }) {
  const notice = useNewRun((s) => s.notice);
  const dirty = useNewRun((s) => s.dirty);
  const closeNotice = useNewRun((s) => s.closeNotice);
  const api = useNewRunApi();
  const choice = useChoice();
  const again = async (andAttach: boolean) => {
    const runId = await api.getState().create(andAttach, choice, true);
    if (runId) onCreated(runId, andAttach);
  };
  return (
    <Notice
      text={notice?.text}
      action={dirty ? { label: START_FROM_COMMIT, run: () => void again(dirty.andAttach) } : undefined}
      onClose={closeNotice}
    />
  );
}

function CreateButton({
  andAttach,
  onCreated,
}: {
  readonly andAttach: boolean;
  readonly onCreated: Created;
}) {
  const busy = useNewRun((s) => s.busy);
  const unread = useOffer((o) => o === undefined);
  const api = useNewRunApi();
  const choice = useChoice();
  const create = async () => {
    const runId = await api.getState().create(andAttach, choice);
    if (runId) onCreated(runId, andAttach);
  };
  return (
    <Button
      variant={andAttach ? "primary" : "default"}
      disabled={busy || unread}
      title={unread ? "the workflows are not read yet" : undefined}
      onClick={() => void create()}
    >
      {andAttach ? "Create and attach" : "Create in background"}
    </Button>
  );
}

/** The `metator run new` the form amounts to: it follows every field, the task's letters too. */
function Command() {
  const { workflow, host, autonomy } = useChoice();
  const task = useNewRun((s) => s.task);
  const worktree = useNewRun((s) => s.worktree);
  const parent = useNewRun((s) => s.parent);
  return (
    <code>{`metator run new --workflow ${workflow || "<workflow>"} --task ${JSON.stringify(task || "<task>")}${autonomy !== "L0" ? ` --autonomy ${autonomy}` : ""}${worktree ? " --worktree" : ""}${parent ? ` --parent ${parent}` : ""}${host ? ` && metator run drive --host ${host} --detach` : ""}`}</code>
  );
}
