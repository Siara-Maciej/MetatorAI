/**
 * Overview → System: the system plans of the repository (one opens with its steps, its approval
 * and its editing), the system map (applications and contracts, edited like a plan), where the
 * applications' code is on this machine (`system.roots`), and "Discover": what the code shows
 * that the map lacks, previewed before it is written.
 */
import { useState } from "react";
import type { SystemDiscoveryView, SystemMap, SystemMapView } from "../api.ts";
import { Notice } from "../components/common.tsx";
import { type DocSource, EditBar, ProblemList, useDocEditor } from "../components/doc-editor.tsx";
import { EmptyRow, ListRow, ListSection } from "../components/list-detail.tsx";
import { SystemPlanPanel } from "../components/system-plan.tsx";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { lookOf, plural, rootsProblems, routeHash } from "../model.ts";
import {
  blankApplication,
  blankContract,
  listOf,
  type MapApplication,
  type MapContract,
  mapChanges,
  moved,
  sourceOf,
  sourceText,
  textOf,
} from "../plan-edit.ts";
import { TextEditor } from "../run/plan-form.tsx";

const PLAN_LOOK: Record<string, string> = {
  draft: "todo",
  approved: "blocked",
  running: "in-progress",
  done: "done",
};

export function SystemPanel({ onOpenRun }: { onOpenRun(runId: string): void }) {
  const { client, repo, runs } = useDaemon("client", "repo", "runs");
  const list = usePolled(`system-plans-all:${repo ?? ""}`, () => client.systemPlans(repo), 5000);
  const [chosen, setChosen] = useState<string>();
  const plans = Array.isArray(list.data) ? list.data : [];
  const current = plans.find((p) => p.id === chosen);
  // A plan's page is its system run's: the row opens it there (its flow, steps and runs).
  const headOf = (task: string) => runs.find((r) => /system/.test(r.workflow) && r.task === task);
  return (
    <div className="system-tab" data-testid="overview-system">
      <div className="ld-body system-body">
        <aside className="ld-list" aria-label="system plans">
          <ListSection>system plans · {plans.length}</ListSection>
          {plans.map((p) => (
            <ListRow
              key={p.id}
              className="item"
              selected={current?.id === p.id}
              onSelect={() => {
                const head = headOf(p.task);
                if (head)
                  window.location.hash = routeHash({ screen: "run", runId: head.runId, tab: "overview" });
                else setChosen(p.id);
              }}
              testId={`system-plan-${p.id}`}
              glyph={
                <span className={`g ${lookOf("step", PLAN_LOOK[p.status]).tone ?? ""}`}>
                  {lookOf("step", PLAN_LOOK[p.status]).glyph}
                </span>
              }
              title={p.task}
              sub={`${p.id} · ${p.status} · ${p.done}/${plural(p.steps, "step")}${p.approval?.stale ? " · approval stale" : ""}`}
            />
          ))}
          {list.error && !list.data ? (
            <EmptyRow>The system plans could not be read: {list.error}</EmptyRow>
          ) : null}
          {list.data && plans.length === 0 ? (
            <EmptyRow>No system plan yet. A run of the workflow mt-system-change writes one.</EmptyRow>
          ) : null}
          <span className="spacer" />
          <ListSection>the system</ListSection>
          <ListRow
            className="item"
            selected={chosen === "map"}
            onSelect={() => setChosen("map")}
            testId="system-map-row"
            glyph={<span className="g faint">◇</span>}
            title="System map"
            sub="applications, contracts, where the code is"
          />
        </aside>
        <section className="ld-detail">
          {chosen === "map" || !current ? (
            <SystemMapEditor />
          ) : (
            // A plan whose system run is not here (another repository's, or gone): shown as it is.
            <SystemPlanPanel planId={current.id} repo={repo} onOpenRun={onOpenRun} flow={false} />
          )}
        </section>
      </div>
    </div>
  );
}

function SystemMapEditor() {
  const { client, repo, optionsView, reloadOptions } = useDaemon(
    "client",
    "repo",
    "optionsView",
    "reloadOptions",
  );
  const map = usePolled(`system-map:${repo ?? ""}`, () => client.systemMap(repo), 5000);
  const action = useAction(map.reload);
  const source: DocSource<SystemMapView, SystemMap> = {
    view: map.data,
    reload: map.reload,
    docOf: (v) => v.map,
    digestOf: (v) => v.digest,
    lintOf: (v) => v.lint,
    editable: (v) => v.editable,
    readOnlyBecause: (v) => v.readOnlyBecause,
    save: (m, digest, by) => client.saveSystemMap({ map: m, digest, by }, repo),
    changes: mapChanges,
    blank: () =>
      ({
        system: "system",
        applications: [blankApplication({ applications: [] })],
        contracts: [],
        policies: { deployOrder: "providers-first", breaking: "expand-contract" },
      }) as SystemMap,
  };
  const editor = useDocEditor(source);
  const [found, setFound] = useState<SystemDiscoveryView>();
  const rootsOption = optionsView?.options.find((o) => o.key === "system.roots");
  const roots = Array.isArray(rootsOption?.value) ? (rootsOption?.value as string[]) : [];
  // The roots as a list being edited: one path per row; undefined while nothing changed.
  const [rootsDraft, setRootsDraft] = useState<string[]>();
  const view = map.data;
  const m = view?.map;
  const discover = async (write: boolean) => {
    let answer: SystemDiscoveryView | undefined;
    const ok = await action.run(
      async (by) => {
        const r = await client.discover(write ? { write, by } : { write }, repo);
        answer = r.data;
        return r;
      },
      write ? { who: true, done: "the map is written" } : { refused: "discovery did not answer" },
    );
    if (ok) setFound(write ? undefined : answer);
  };
  const rootsList = rootsDraft ?? roots;
  const rootsWrong = rootsDraft ? rootsProblems(rootsDraft) : [];
  const editRoots = (next: string[]) => setRootsDraft(next);
  const saveRoots = (paths: readonly string[]) =>
    action
      .run(
        () =>
          client.setOption(
            "system.roots",
            {
              scope: rootsOption?.definition.scope === "user" ? "user" : "repo",
              value: paths.map((p) => p.trim()),
            },
            repo,
          ),
        { done: "the roots are saved" },
      )
      .then(async (r) => {
        if (r) setRootsDraft(undefined);
        await reloadOptions();
        return r;
      });
  return (
    <div className="system-map" data-testid="system-map">
      <header className="sp-head">
        <h2>System map</h2>
        {view ? <span className="faint mono">{view.file}</span> : null}
        <span className="spacer" />
        <button type="button" disabled={action.busy} onClick={() => void discover(false)}>
          Discover…
        </button>
      </header>
      {map.error && !view ? <div className="banner">{map.error}</div> : null}
      <Notice {...action.notice} />
      {found ? (
        <section className="discovery" aria-label="what discovery found" data-testid="discovery">
          <h3>What the code shows that the map lacks</h3>
          {!m ? (
            <>
              <div className="faint">
                There is no map yet: this is the map the code shows. "Write the map" saves it to{" "}
                <span className="mono">{found.file ?? view?.file ?? "the map's file"}</span>.
              </div>
              <MapTables map={found.proposed} />
            </>
          ) : found.changes.length === 0 ? (
            <div className="faint">Nothing: the map says what the code shows.</div>
          ) : (
            <ul>
              {found.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={(m !== null && m !== undefined && found.changes.length === 0) || action.busy}
              onClick={() => void discover(true)}
            >
              Write the map
            </button>
            <button type="button" onClick={() => setFound(undefined)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}
      <section className="roots" aria-label="where the code is">
        <h3>Where the applications' code is</h3>
        {rootsOption ? (
          <>
            <p className="faint">
              The directories that hold the applications' checkouts (option{" "}
              <span className="mono">system.roots</span>, {rootsOption.definition.scope} scope).
            </p>
            <ul className="roots-list" aria-label="system roots" data-testid="system-roots">
              {rootsList.length === 0 ? (
                <li className="faint">No root yet: the map's own paths are used.</li>
              ) : null}
              {rootsList.map((path, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place in the list
                <li key={i} className="row">
                  <input
                    aria-label={`root ${i + 1}`}
                    className="mono"
                    placeholder="/home/you/code"
                    value={path}
                    onChange={(e) => editRoots(rootsList.map((p, j) => (j === i ? e.target.value : p)))}
                  />
                  <button
                    type="button"
                    className="ghost"
                    aria-label={`remove root ${i + 1}`}
                    title="remove this path"
                    onClick={() => editRoots(rootsList.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            {rootsWrong.length > 0 ? (
              <ul className="red" data-testid="roots-problems">
                {rootsWrong.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
            <div className="actions">
              <button type="button" onClick={() => editRoots([...rootsList, ""])}>
                + Path
              </button>
              <button
                type="button"
                className="primary"
                disabled={rootsDraft === undefined || rootsWrong.length > 0 || action.busy}
                onClick={() => void saveRoots(rootsList)}
              >
                Save roots
              </button>
              {rootsDraft ? (
                <button type="button" onClick={() => setRootsDraft(undefined)}>
                  Cancel
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="faint" data-testid="roots-unknown">
            This daemon has no option <span className="mono">system.roots</span>: the paths come from the map.
          </p>
        )}
        {view && view.roots.length > 0 ? (
          <div className="faint">
            Found: <span className="mono">{view.roots.join(", ")}</span>
          </div>
        ) : null}
      </section>
      {view ? (
        <EditBar editor={editor} source={source} noun="system map" testId="system-map-edit-bar" />
      ) : null}
      {editor.mode === "text" ? (
        <TextEditor
          text={editor.text}
          label="the system map as JSON"
          problems={editor.problems}
          onChange={editor.setText}
        />
      ) : editor.mode === "form" && editor.draft ? (
        <MapForm map={editor.draft} onChange={editor.setDraft} />
      ) : m ? (
        <>
          <ProblemList problems={editor.problems} />
          <MapTables map={m} />
        </>
      ) : view ? (
        <div className="empty">
          <h2>No system map</h2>
          <p>Discover proposes one from the code, or edit one by hand.</p>
        </div>
      ) : null}
    </div>
  );
}

function MapTables({ map }: { readonly map: SystemMap }) {
  return (
    <>
      <h3>
        {map.system} · {plural(map.applications.length, "application")}
      </h3>
      <table className="sp-steps">
        <thead>
          <tr>
            {["application", "kind", "code", "owners", "consumes"].map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {map.applications.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.id}</td>
              <td>{a.kind}</td>
              <td className="mono">{sourceText(a.source)}</td>
              <td>{textOf(a.owners) || "—"}</td>
              <td className="mono">{textOf(a.consumes) || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>{plural(map.contracts.length, "contract")}</h3>
      <table className="sp-steps">
        <thead>
          <tr>
            {["contract", "kind", "owner", "specification", "compatibility"].map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {map.contracts.map((c) => (
            <tr key={c.id}>
              <td className="mono">{c.id}</td>
              <td>{c.kind}</td>
              <td className="mono">{c.owner}</td>
              <td className="mono">{"path" in c.spec ? c.spec.path : `served at ${c.spec.served}`}</td>
              <td>{c.compatibility}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const KINDS = ["frontend", "service", "worker", "gateway", "library", "other"] as const;

function MapForm({
  map,
  onChange,
}: {
  readonly map: SystemMap;
  onChange(change: (m: SystemMap) => SystemMap): void;
}) {
  const app = (i: number, patch: Partial<MapApplication>) =>
    onChange((m) => ({
      ...m,
      applications: m.applications.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    }));
  const contract = (i: number, patch: Partial<MapContract>) =>
    onChange((m) => ({
      ...m,
      contracts: m.contracts.map((c, j) => (j === i ? ({ ...c, ...patch } as MapContract) : c)),
    }));
  return (
    <div className="plan-form" data-testid="system-map-form">
      <label className="pf-field">
        <span>System</span>
        <input
          aria-label="system name"
          className="mono"
          value={map.system}
          onChange={(e) => onChange((m) => ({ ...m, system: e.target.value }))}
        />
      </label>
      <h3>Applications</h3>
      <ol className="pf-steps">
        {map.applications.map((a, i) => (
          <li key={`app-${String(i)}`} className="pf-step" aria-label={`application ${a.id}`}>
            <div className="pf-head">
              <b className="mono">{a.id || "(no id)"}</b>
              <span className="spacer" />
              <button
                type="button"
                className="ghost"
                aria-label={`move ${a.id} up`}
                disabled={i === 0}
                onClick={() => onChange((m) => ({ ...m, applications: moved(m.applications, i, -1) }))}
              >
                ↑
              </button>
              <button
                type="button"
                className="ghost"
                aria-label={`move ${a.id} down`}
                disabled={i === map.applications.length - 1}
                onClick={() => onChange((m) => ({ ...m, applications: moved(m.applications, i, 1) }))}
              >
                ↓
              </button>
              <button
                type="button"
                className="ghost"
                aria-label={`remove ${a.id}`}
                onClick={() =>
                  onChange((m) => ({ ...m, applications: m.applications.filter((_, j) => j !== i) }))
                }
              >
                ✕
              </button>
            </div>
            <div className="pf-grid">
              <label className="pf-field">
                <span>Id</span>
                <input
                  aria-label={`application ${i + 1} id`}
                  className="mono"
                  value={a.id}
                  onChange={(e) => app(i, { id: e.target.value })}
                />
              </label>
              <label className="pf-field">
                <span>Kind</span>
                <select
                  aria-label={`${a.id} kind`}
                  value={a.kind}
                  onChange={(e) => app(i, { kind: e.target.value as MapApplication["kind"] })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pf-field">
                <span>Code</span>
                <input
                  aria-label={`${a.id} code`}
                  className="mono"
                  placeholder="a path here, or repo:<repo>[@ref][:path]"
                  value={sourceText(a.source)}
                  onChange={(e) => app(i, { source: sourceOf(e.target.value) })}
                />
              </label>
              <label className="pf-field">
                <span>Owners</span>
                <input
                  aria-label={`${a.id} owners`}
                  value={textOf(a.owners)}
                  onChange={(e) => app(i, { owners: listOf(e.target.value) })}
                />
              </label>
              <label className="pf-field">
                <span>Consumes</span>
                <input
                  aria-label={`${a.id} consumes`}
                  className="mono"
                  placeholder="contract or contract@^2"
                  value={textOf(a.consumes)}
                  onChange={(e) => app(i, { consumes: listOf(e.target.value) })}
                />
              </label>
            </div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => onChange((m) => ({ ...m, applications: [...m.applications, blankApplication(m)] }))}
      >
        + Application
      </button>
      <h3>Contracts</h3>
      <ol className="pf-steps">
        {map.contracts.map((c, i) => (
          <li key={`contract-${String(i)}`} className="pf-step" aria-label={`contract ${c.id}`}>
            <div className="pf-head">
              <b className="mono">{c.id || "(no id)"}</b>
              <span className="spacer" />
              <button
                type="button"
                className="ghost"
                aria-label={`remove ${c.id}`}
                onClick={() => onChange((m) => ({ ...m, contracts: m.contracts.filter((_, j) => j !== i) }))}
              >
                ✕
              </button>
            </div>
            <div className="pf-grid">
              <label className="pf-field">
                <span>Id</span>
                <input
                  aria-label={`contract ${i + 1} id`}
                  className="mono"
                  value={c.id}
                  onChange={(e) => contract(i, { id: e.target.value })}
                />
              </label>
              <label className="pf-field">
                <span>Kind</span>
                <input
                  aria-label={`${c.id} kind`}
                  className="mono"
                  value={c.kind}
                  onChange={(e) => contract(i, { kind: e.target.value })}
                />
              </label>
              <label className="pf-field">
                <span>Owner</span>
                <select
                  aria-label={`${c.id} owner`}
                  value={c.owner}
                  onChange={(e) => contract(i, { owner: e.target.value })}
                >
                  {map.applications.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pf-field">
                <span>Specification</span>
                <input
                  aria-label={`${c.id} specification`}
                  className="mono"
                  placeholder="openapi.yaml, or /docs-json when served"
                  value={"path" in c.spec ? c.spec.path : c.spec.served}
                  onChange={(e) =>
                    contract(i, {
                      spec: e.target.value.startsWith("/")
                        ? { served: e.target.value }
                        : { path: e.target.value },
                    })
                  }
                />
              </label>
            </div>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => onChange((m) => ({ ...m, contracts: [...m.contracts, blankContract(m)] }))}
      >
        + Contract
      </button>
    </div>
  );
}
