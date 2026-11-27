/**
 * The system map's editor (the only document the app edits): the map as tables, a draft as fields or JSON, Check (the daemon's lint) and Save (what changes, then a write that names the digest it was read at).
 *
 * The screen only lays its parts out (ADR-0113): what it keeps is the SystemMap store
 * (`system-map-state.ts`) and the document editor's store; a row of the form reads only its own
 * application or contract, so typing in a field draws that row again, not the form.
 */
import { useShallow } from "zustand/react/shallow";
import type { SystemMap, SystemMapView } from "../../shared/api/api.ts";
import { useDaemon, useDaemonStore, usePolled, usePolledSelect } from "../../shared/daemon/daemon.tsx";
import { plural } from "../../shared/model/format.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Notice } from "../../ui/notice.tsx";
import { DocEditorScope, EditBar, ProblemList, useProblems } from "../plans/doc-editor.tsx";
import { type DocSource, useDocEdit } from "../plans/doc-editor-state.ts";
import {
  blankApplication,
  blankContract,
  listOf,
  type MapApplication,
  type MapContract,
  moved,
  sourceOf,
  sourceText,
  textOf,
} from "../plans/plan-edit.ts";
import { TextEditor } from "../plans/plan-form.tsx";
import { rootsProblems } from "./model.ts";
import { mapSource, SystemMapScreen, systemMapKey, useSystemMap } from "./system-map-state.ts";

type MapSource = DocSource<SystemMapView, SystemMap>;

export function SystemMapEditor() {
  const daemon = useDaemonStore();
  const source = mapSource(daemon);
  return (
    <ScopeProvider store={SystemMapScreen} init={{ daemon }}>
      <DocEditorScope source={source}>
        <div className="system-map" data-testid="system-map">
          <MapHead />
          <MapReadError />
          <MapNotice />
          <Discovery />
          <Roots />
          <MapEditBar source={source} />
          <MapBody source={source} />
        </div>
      </DocEditorScope>
    </ScopeProvider>
  );
}

/** The map as the daemon answered it last, or `select`'s part of it (undefined before the first answer). */
function useMapView<R>(select: (view: SystemMapView | undefined) => R): R {
  const { client, repo } = useDaemon("client", "repo");
  return usePolledSelect(systemMapKey(repo), () => client.systemMap(repo), 5000, select);
}
const whole = (v: SystemMapView | undefined) => v;

function MapHead() {
  const file = useMapView((v) => v?.file);
  const busy = useSystemMap((s) => s.busy);
  const discover = useSystemMap((s) => s.discover);
  return (
    <header className="sp-head">
      <h2>System map</h2>
      {file ? <span className="faint mono">{file}</span> : null}
      <span className="spacer" />
      <Button disabled={busy} onClick={() => void discover(false)}>
        Discover…
      </Button>
    </header>
  );
}

/** The map could not be read, and there is none to show. */
function MapReadError() {
  const { client, repo } = useDaemon("client", "repo");
  const map = usePolled(systemMapKey(repo), () => client.systemMap(repo), 5000);
  return map.error && !map.data ? <div className="banner">{map.error}</div> : null;
}

function MapNotice() {
  const notice = useSystemMap((s) => s.notice);
  const closeNotice = useSystemMap((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
}

/** What "Discover…" found that the map lacks, before it is written. */
function Discovery() {
  const found = useSystemMap((s) => s.found);
  const busy = useSystemMap((s) => s.busy);
  const discover = useSystemMap((s) => s.discover);
  const closeFound = useSystemMap((s) => s.closeFound);
  const m = useMapView((v) => v?.map);
  const file = useMapView((v) => v?.file);
  if (!found) return null;
  return (
    <section className="discovery" aria-label="what discovery found" data-testid="discovery">
      <h3>What the code shows that the map lacks</h3>
      {!m ? (
        <>
          <div className="faint">
            There is no map yet: this is the map the code shows. "Write the map" saves it to{" "}
            <span className="mono">{found.file ?? file ?? "the map's file"}</span>.
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
        <Button
          variant="primary"
          disabled={(m !== null && m !== undefined && found.changes.length === 0) || busy}
          onClick={() => void discover(true)}
        >
          Write the map
        </Button>
        <Button onClick={closeFound}>Cancel</Button>
      </div>
    </section>
  );
}

const NO_ROOTS: readonly string[] = [];

/** Where the applications' code is on this machine (`system.roots`), edited as a list. */
function Roots() {
  const { optionsView } = useDaemon("optionsView");
  const rootsDraft = useSystemMap((s) => s.rootsDraft);
  const busy = useSystemMap((s) => s.busy);
  const editRoots = useSystemMap((s) => s.editRoots);
  const cancelRoots = useSystemMap((s) => s.cancelRoots);
  const saveRoots = useSystemMap((s) => s.saveRoots);
  const found = useMapView((v) => v?.roots ?? NO_ROOTS);
  const rootsOption = optionsView?.options.find((o) => o.key === "system.roots");
  const roots = Array.isArray(rootsOption?.value) ? (rootsOption?.value as string[]) : [];
  const rootsList = rootsDraft ?? roots;
  const rootsWrong = rootsDraft ? rootsProblems([...rootsDraft]) : [];
  return (
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
                <Button
                  variant="ghost"
                  aria-label={`remove root ${i + 1}`}
                  title="remove this path"
                  onClick={() => editRoots(rootsList.filter((_, j) => j !== i))}
                >
                  ✕
                </Button>
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
            <Button onClick={() => editRoots([...rootsList, ""])}>+ Path</Button>
            <Button
              variant="primary"
              disabled={rootsDraft === undefined || rootsWrong.length > 0 || busy}
              onClick={() =>
                void saveRoots(rootsList, rootsOption.definition.scope === "user" ? "user" : "repo")
              }
            >
              Save roots
            </Button>
            {rootsDraft ? <Button onClick={cancelRoots}>Cancel</Button> : null}
          </div>
        </>
      ) : (
        <p className="faint" data-testid="roots-unknown">
          This daemon has no option <span className="mono">system.roots</span>: the paths come from the map.
        </p>
      )}
      {found.length > 0 ? (
        <div className="faint">
          Found: <span className="mono">{found.join(", ")}</span>
        </div>
      ) : null}
    </section>
  );
}

function MapEditBar({ source }: { readonly source: MapSource }) {
  const view = useMapView(whole);
  return view ? <EditBar view={view} source={source} noun="system map" testId="system-map-edit-bar" /> : null;
}

/** The draft as text, as fields, or the map as tables. */
function MapBody({ source }: { readonly source: MapSource }) {
  const mode = useDocEdit((s) => s.mode);
  const drafted = useDocEdit((s) => s.draft !== undefined);
  if (mode === "text") return <MapText source={source} />;
  if (mode === "form" && drafted) return <MapForm />;
  return <MapShown source={source} />;
}

function MapText({ source }: { readonly source: MapSource }) {
  const view = useMapView(whole);
  const problems = useProblems(view, source);
  const text = useDocEdit((s) => s.text);
  const setText = useDocEdit((s) => s.setText);
  return <TextEditor text={text} label="the system map as JSON" problems={problems} onChange={setText} />;
}

function MapShown({ source }: { readonly source: MapSource }) {
  const view = useMapView(whole);
  const problems = useProblems(view, source);
  const m = view?.map;
  return m ? (
    <>
      <ProblemList problems={problems} />
      <MapTables map={m} />
    </>
  ) : view ? (
    <div className="empty">
      <h2>No system map</h2>
      <p>Discover proposes one from the code, or edit one by hand.</p>
    </div>
  ) : null;
}

/* ---------- the map as fields: each row reads its own part of the draft ---------- */

/** A part of the draft (a map while the form shows). */
const useDraft = <T,>(select: (m: SystemMap) => T): T =>
  useDocEdit((s) => select((s.draft ?? EMPTY_MAP) as SystemMap));
const EMPTY_MAP = { system: "", applications: [], contracts: [] } as unknown as SystemMap;

/** Changes the draft at the moment of an event. */
function useChange(): (change: (m: SystemMap) => SystemMap) => void {
  const setDraft = useDocEdit((s) => s.setDraft);
  return (change) => setDraft<SystemMap>(change);
}

function MapForm() {
  const apps = useDraft((m) => m.applications.length);
  const contracts = useDraft((m) => m.contracts.length);
  const change = useChange();
  return (
    <div className="plan-form" data-testid="system-map-form">
      <SystemNameField />
      <h3>Applications</h3>
      <ol className="pf-steps">
        {Array.from({ length: apps }, (_, i) => (
          <AppRow key={`app-${String(i)}`} i={i} />
        ))}
      </ol>
      <Button
        onClick={() => change((m) => ({ ...m, applications: [...m.applications, blankApplication(m)] }))}
      >
        + Application
      </Button>
      <h3>Contracts</h3>
      <ol className="pf-steps">
        {Array.from({ length: contracts }, (_, i) => (
          <ContractRow key={`contract-${String(i)}`} i={i} />
        ))}
      </ol>
      <Button onClick={() => change((m) => ({ ...m, contracts: [...m.contracts, blankContract(m)] }))}>
        + Contract
      </Button>
    </div>
  );
}

export function SystemNameField() {
  const system = useDraft((m) => m.system);
  const change = useChange();
  return (
    <label className="pf-field">
      <span>System</span>
      <input
        aria-label="system name"
        className="mono"
        value={system}
        onChange={(e) => change((m) => ({ ...m, system: e.target.value }))}
      />
    </label>
  );
}

const KINDS = ["frontend", "service", "worker", "gateway", "library", "other"] as const;

export function AppRow({ i }: { readonly i: number }) {
  const a = useDraft((m) => m.applications[i]);
  const last = useDraft((m) => i === m.applications.length - 1);
  const change = useChange();
  if (!a) return null;
  const app = (patch: Partial<MapApplication>) =>
    change((m) => ({ ...m, applications: m.applications.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  return (
    <li className="pf-step" aria-label={`application ${a.id}`}>
      <div className="pf-head">
        <b className="mono">{a.id || "(no id)"}</b>
        <span className="spacer" />
        <Button
          variant="ghost"
          aria-label={`move ${a.id} up`}
          disabled={i === 0}
          onClick={() => change((m) => ({ ...m, applications: moved(m.applications, i, -1) }))}
        >
          ↑
        </Button>
        <Button
          variant="ghost"
          aria-label={`move ${a.id} down`}
          disabled={last}
          onClick={() => change((m) => ({ ...m, applications: moved(m.applications, i, 1) }))}
        >
          ↓
        </Button>
        <Button
          variant="ghost"
          aria-label={`remove ${a.id}`}
          onClick={() => change((m) => ({ ...m, applications: m.applications.filter((_, j) => j !== i) }))}
        >
          ✕
        </Button>
      </div>
      <div className="pf-grid">
        <label className="pf-field">
          <span>Id</span>
          <input
            aria-label={`application ${i + 1} id`}
            className="mono"
            value={a.id}
            onChange={(e) => app({ id: e.target.value })}
          />
        </label>
        <label className="pf-field">
          <span>Kind</span>
          <select
            aria-label={`${a.id} kind`}
            value={a.kind}
            onChange={(e) => app({ kind: e.target.value as MapApplication["kind"] })}
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
            onChange={(e) => app({ source: sourceOf(e.target.value) })}
          />
        </label>
        <label className="pf-field">
          <span>Owners</span>
          <input
            aria-label={`${a.id} owners`}
            value={textOf(a.owners)}
            onChange={(e) => app({ owners: listOf(e.target.value) })}
          />
        </label>
        <label className="pf-field">
          <span>Consumes</span>
          <input
            aria-label={`${a.id} consumes`}
            className="mono"
            placeholder="contract or contract@^2"
            value={textOf(a.consumes)}
            onChange={(e) => app({ consumes: listOf(e.target.value) })}
          />
        </label>
      </div>
    </li>
  );
}

function ContractRow({ i }: { readonly i: number }) {
  const c = useDraft((m) => m.contracts[i]);
  // The owners it may name: the applications' ids, read as one list that changes only with them.
  const ids = useDocEdit(
    useShallow((s) => ((s.draft ?? EMPTY_MAP) as SystemMap).applications.map((a) => a.id)),
  );
  const change = useChange();
  if (!c) return null;
  const contract = (patch: Partial<MapContract>) =>
    change((m) => ({
      ...m,
      contracts: m.contracts.map((x, j) => (j === i ? ({ ...x, ...patch } as MapContract) : x)),
    }));
  return (
    <li className="pf-step" aria-label={`contract ${c.id}`}>
      <div className="pf-head">
        <b className="mono">{c.id || "(no id)"}</b>
        <span className="spacer" />
        <Button
          variant="ghost"
          aria-label={`remove ${c.id}`}
          onClick={() => change((m) => ({ ...m, contracts: m.contracts.filter((_, j) => j !== i) }))}
        >
          ✕
        </Button>
      </div>
      <div className="pf-grid">
        <label className="pf-field">
          <span>Id</span>
          <input
            aria-label={`contract ${i + 1} id`}
            className="mono"
            value={c.id}
            onChange={(e) => contract({ id: e.target.value })}
          />
        </label>
        <label className="pf-field">
          <span>Kind</span>
          <input
            aria-label={`${c.id} kind`}
            className="mono"
            value={c.kind}
            onChange={(e) => contract({ kind: e.target.value })}
          />
        </label>
        <label className="pf-field">
          <span>Owner</span>
          <select
            aria-label={`${c.id} owner`}
            value={c.owner}
            onChange={(e) => contract({ owner: e.target.value })}
          >
            {ids.map((id) => (
              <option key={id} value={id}>
                {id}
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
              contract({
                spec: e.target.value.startsWith("/") ? { served: e.target.value } : { path: e.target.value },
              })
            }
          />
        </label>
      </div>
    </li>
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
