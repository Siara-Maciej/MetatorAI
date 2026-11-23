/**
 * Add repository (round 20, ADR-0105): pick a folder or type its path, read what the app found in
 * plain words, choose the AI host, Set up with its output as one progress line, then the commit
 * card (Commit / Not now: the commit is the person's), then Open. The steps are `flowStep`
 * (repos.ts); this screen runs the shell's command each busy step names and draws the rest. In a
 * browser it shows the commands to run instead (`WebAdd`).
 *
 * Round 21 (ADR-0106): a third source, "Dev Container": the containers the engine lists (Start a
 * stopped one, Refresh), then the one picked gets MetatorAI installed with its progress
 * (`containerStep`, devcontainers.ts), and the same flow runs in the container (`inContainer`).
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Tabs } from "../components/tabs.tsx";
import {
  type ContainerEvent,
  type ContainerFlow,
  containerRows,
  containerStep,
  DEVCONTAINER_DOCS,
  folderName,
  inContainer,
  installErrorText,
  installLine,
  LISTING,
  readContainerList,
} from "../devcontainers.ts";
import {
  alreadyAdded,
  commitQuestion,
  DESKTOP_DOWNLOAD,
  type Flow,
  type FlowEvent,
  flowStep,
  hostChoices,
  hostName,
  pathOf,
  progressLine,
  readInspection,
  repoName,
  requirements,
  START,
  shortSha,
  type Where,
  webCommands,
  writesFor,
} from "../repos.ts";
import { useRepos } from "../repos-context.tsx";
import {
  asCommandError,
  type Commands,
  type DevContainer,
  errorText,
  installWithOutput,
  setupWithOutput,
} from "../tauri-commands.ts";
import { RequirementList } from "./first-run.tsx";

/** Where the repository comes from. */
type Source = "folder" | "repos" | "devcontainer";

const SOURCES: readonly { readonly id: Source; readonly label: string }[] = [
  { id: "folder", label: "Folder on this computer" },
  { id: "repos", label: "Folder of repositories" },
  { id: "devcontainer", label: "Dev Container" },
];

export function AddRepoScreen() {
  const { commands } = useRepos();
  return commands ? <AddFlow commands={commands} /> : <WebAdd />;
}

function AddFlow({ commands }: { readonly commands: Commands }) {
  const repos = useRepos();
  const [source, setSource] = useState<Source>("folder");
  const [flow, dispatch] = useReducer(flowStep, START);
  const [boxes, box] = useReducer(containerStep, LISTING);
  // The dev container the flow runs in, once MetatorAI is installed there; none on this computer.
  const [place, setPlace] = useState<DevContainer>();
  const where: Where = place ? "container" : "here";
  const run = useMemo(() => (place ? inContainer(commands, place.localFolder) : commands), [commands, place]);
  const now = useRef<Flow>(flow);
  now.current = flow;
  const addAndOpen = useRef(repos.addAndOpen);
  addAndOpen.current = repos.addAndOpen;
  const step = flow.step;
  // Each busy step runs its one command; what it answers is the next event.
  useEffect(() => {
    void step;
    const f = now.current;
    let live = true;
    const say = (e: FlowEvent) => {
      if (live) dispatch(e);
    };
    const fail = (e: unknown) => say({ type: "failed", error: errorText(e) });
    switch (f.step) {
      case "inspecting":
        run.inspectFolder(f.path).then((inspection) => say({ type: "inspected", inspection }), fail);
        break;
      case "initializing":
        run
          .gitInit(f.inspection.path)
          .then(() => run.inspectFolder(f.inspection.path))
          .then((inspection) => say({ type: "inspected", inspection }), fail);
        break;
      case "setting-up":
        setupWithOutput(run, f.target, f.host, (line) => say({ type: "line", line })).then(
          (done) =>
            say(
              done.ok
                ? { type: "setup-done", written: done.written }
                : { type: "failed", error: done.error ? errorText(done.error) : "setup did not finish" },
            ),
          fail,
        );
        break;
      case "committing":
        run.commitSetup(f.target, f.written).then((r) => say({ type: "committed", commit: r.commit }), fail);
        break;
      case "opening":
        void addAndOpen
          .current(f.path, place?.localFolder)
          .then((why) => say(why ? { type: "failed", error: why } : { type: "opened" }));
        break;
    }
    return () => {
      live = false;
    };
  }, [step, run, place]);
  // The Dev Container source's busy steps, the same way: list, start, install.
  const boxNow = useRef<ContainerFlow>(boxes);
  boxNow.current = boxes;
  const boxStep = source === "devcontainer" ? boxes.step : undefined;
  useEffect(() => {
    void boxStep;
    const b = boxNow.current;
    let live = true;
    const say = (e: ContainerEvent) => {
      if (live) box(e);
    };
    const fail = (e: unknown) => say({ type: "failed", error: errorText(e) });
    if (boxStep === undefined) return;
    switch (b.step) {
      case "listing":
        commands.listDevContainers().then((list) => say({ type: "listed", list }), fail);
        break;
      case "starting":
        commands.startDevContainer(b.key).then((container) => say({ type: "started", container }), fail);
        break;
      case "installing":
        installWithOutput(commands, b.container.localFolder, (line) => say({ type: "line", line })).then(
          (done) =>
            done.ok
              ? say({ type: "installed", version: done.version ?? "" })
              : say({
                  type: "failed",
                  error: done.error
                    ? installErrorText(done.error, errorText(done.error))
                    : "the install did not finish",
                }),
          (e) => say({ type: "failed", error: installErrorText(asCommandError(e), errorText(e)) }),
        );
        break;
      case "installed":
        // Installed: the round-20 flow takes over, in the container, at its workspace folder.
        setPlace(b.container);
        dispatch({ type: "inspect", path: b.container.workspaceFolder ?? "" });
        break;
    }
    return () => {
      live = false;
    };
  }, [boxStep, commands]);
  const [output, setOutput] = useState(false);
  const [pickError, setPickError] = useState<string>();
  const pick = async () => {
    setPickError(undefined);
    try {
      const path = await commands.pickFolder();
      if (path) dispatch({ type: "inspect", path });
    } catch (e) {
      setPickError(`The folder picker did not open: ${errorText(e)}. Type the path instead.`);
    }
  };
  const resting = flow.step === "inspected" || flow.step === "ready";
  /** Change: back to the folder, or to the list of dev containers. */
  const change = () => {
    dispatch({ type: "back" });
    if (place) {
      setPlace(undefined);
      box({ type: "back" });
      dispatch({ type: "type", path: "" });
    }
  };
  const picking = flow.step === "pick" && !place;
  return (
    <div className="setup-page" data-testid="add-repo">
      <div className="panel">
        <h1>Add repository</h1>
        {picking &&
        !(source === "devcontainer" && (boxes.step === "installing" || boxes.step === "installed")) ? (
          <Tabs
            label="where the repository is"
            items={SOURCES}
            current={source}
            onSelect={(id) => setSource(id)}
            className="tabs sources"
            testId="sources"
          />
        ) : null}
        {picking && source === "devcontainer" ? (
          <Containers
            flow={boxes}
            dispatch={box}
            onOpenKnown={(localFolder) => {
              const k = repos.known?.find((x) => x.devcontainer?.localFolder === localFolder);
              if (k) void repos.open(k.path);
            }}
            output={output}
            onOutput={() => setOutput(!output)}
          />
        ) : picking ? (
          <>
            <p className="muted">
              {source === "repos"
                ? "Choose the folder that holds your repositories."
                : "Choose your repository, or a folder of repositories."}
            </p>
            <form
              className="addr"
              onSubmit={(e) => {
                e.preventDefault();
                dispatch({ type: "inspect", path: flow.path });
              }}
            >
              <button type="button" className="primary" onClick={() => void pick()}>
                Choose folder…
              </button>
              <input
                aria-label="folder path"
                value={flow.path}
                onChange={(e) => dispatch({ type: "type", path: e.target.value })}
                placeholder="or type its path"
              />
              <button type="submit" disabled={flow.path.trim() === ""}>
                Continue
              </button>
            </form>
            {flow.error ? <p className="refusal">{flow.error}</p> : null}
            {pickError ? <p className="refusal">{pickError}</p> : null}
          </>
        ) : (
          <div className="where" data-testid="where">
            {place ? (
              <span className="dim">{repoName({ name: folderOf(place), kind: "devcontainer" })}</span>
            ) : null}
            <code>{pathOf(flow)}</code>
            {resting || (place && flow.step === "pick") ? (
              <button type="button" className="ghost" onClick={change}>
                Change
              </button>
            ) : null}
          </div>
        )}
        {place && flow.step === "pick" && flow.error ? <p className="refusal">{flow.error}</p> : null}
        {flow.step === "inspecting" ? (
          <p className="busy">
            {place ? "Looking at the folder in the container…" : "Looking at the folder…"}
          </p>
        ) : null}
        {flow.step === "inspected" ? (
          <Inspected
            flow={flow}
            where={where}
            container={place?.localFolder}
            dispatch={dispatch}
            output={output}
            onOutput={() => setOutput(!output)}
            onOpenKnown={(path) => void repos.open(path)}
          />
        ) : null}
        {flow.step === "initializing" ? <p className="busy">Running git init…</p> : null}
        {flow.step === "setting-up" ? (
          <section className="progress" data-testid="setup-progress" aria-live="polite">
            <p className="busy">
              Setting up {flow.target.split(/[\\/]/).pop()} for {hostName(flow.host)}
              {place ? " in the container" : ""}…
            </p>
            <p className="line" data-testid="progress-line">
              {progressLine(flow.lines)}
            </p>
            <Output lines={flow.lines} open={output} onToggle={() => setOutput(!output)} />
          </section>
        ) : null}
        {flow.step === "set-up" || flow.step === "committing" ? (
          <section className="commit-card" data-testid="commit-card" aria-label="commit card">
            <h2>{commitQuestion(flow.written)}</h2>
            <ul className="files">
              {flow.written.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
            <p className="dim">
              Only these files go in the commit, with the message “Set up MetatorAI”. Your other changes stay
              as they are.
            </p>
            {flow.step === "set-up" && flow.error ? (
              <p className="refusal">The commit failed: {flow.error}</p>
            ) : null}
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={flow.step === "committing"}
                onClick={() => dispatch({ type: "commit" })}
              >
                {flow.step === "committing" ? "Committing…" : "Commit"}
              </button>
              <button
                type="button"
                disabled={flow.step === "committing"}
                onClick={() => dispatch({ type: "not-now" })}
              >
                Not now
              </button>
            </div>
            <Output lines={flow.lines} open={output} onToggle={() => setOutput(!output)} />
          </section>
        ) : null}
        {flow.step === "ready" ? (
          <section className="ready" data-testid="ready">
            <h2>Ready</h2>
            <p>
              {flow.commit
                ? `Committed as ${shortSha(flow.commit)}.`
                : flow.uncommitted
                  ? `The ${flow.uncommitted === 1 ? "file is" : `${flow.uncommitted} files are`} not committed. Commit when you want.`
                  : "MetatorAI is set up here."}
            </p>
            {flow.error ? <p className="refusal">The app could not open it: {flow.error}</p> : null}
            <div className="actions">
              <button type="button" className="primary" onClick={() => dispatch({ type: "open" })}>
                Open
              </button>
            </div>
          </section>
        ) : null}
        {flow.step === "opening" || flow.step === "open" ? (
          <p className="busy">{place ? "Starting its daemon in the container…" : "Starting its daemon…"}</p>
        ) : null}
      </div>
    </div>
  );
}

/** What the inspection found, and the one next action. */
function Inspected({
  flow,
  where,
  container,
  dispatch,
  output,
  onOutput,
  onOpenKnown,
}: {
  readonly flow: Extract<Flow, { step: "inspected" }>;
  readonly where: Where;
  /** The dev container's local folder label, when the folder is in one. */
  readonly container: string | undefined;
  dispatch(e: FlowEvent): void;
  readonly output: boolean;
  onOutput(): void;
  onOpenKnown(path: string): void;
}) {
  const { known } = useRepos();
  const i = flow.inspection;
  const reading = readInspection(i, flow.host, where);
  const added = alreadyAdded(known, i, container);
  const retry = () => dispatch({ type: "inspect", path: i.path });
  const children = i.folder?.repos ?? [];
  const needsHost =
    reading.kind === "not-set-up" || (reading.kind === "folder" && children.some((c) => c.setUp === "no"));
  return (
    <section className="reading" data-testid="inspection" data-kind={reading.kind}>
      <h2>{added ? "Already in the app" : reading.title}</h2>
      {added ? <p>Open it; nothing is set up again.</p> : reading.lines.map((l) => <p key={l}>{l}</p>)}
      {where === "container" && !added ? (
        // In a container the host check is always shown: what is there is what its sessions get.
        <div className="in-container" data-testid="container-check">
          <h3>In the container</h3>
          <RequirementList items={requirements(i)} onRetry={retry} />
        </div>
      ) : reading.kind === "no-git" || reading.kind === "no-host" ? (
        <RequirementList items={requirements(i)} onRetry={retry} />
      ) : null}
      {!added && reading.kind === "not-set-up" ? (
        <details className="will-write" open>
          <summary>The files setup will write</summary>
          <ul className="files" data-testid="will-write">
            {writesFor(i, flow.host).map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {!added && reading.kind === "folder" ? (
        <ul className="children" data-testid="children">
          {children.map((c) => (
            <li key={c.root}>
              <span className="name">{c.name}</span>
              <span className="dim">{CHILD_WORDS[c.setUp]}</span>
              {c.setUp !== "no" ? null : (
                <button
                  type="button"
                  disabled={flow.host === undefined}
                  onClick={() => dispatch({ type: "setup", target: c.root })}
                >
                  Set up
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {!added && needsHost ? <HostPick flow={flow} dispatch={dispatch} /> : null}
      {flow.error ? <p className="refusal">{flow.error}</p> : null}
      {flow.lines && flow.lines.length > 0 ? (
        <Output lines={flow.lines} open={output} onToggle={onOutput} />
      ) : null}
      <div className="actions">
        {added ? (
          <button type="button" className="primary" onClick={() => onOpenKnown(added.path)}>
            Open
          </button>
        ) : reading.kind === "not-repo" ? (
          <button type="button" className="primary" onClick={() => dispatch({ type: "git-init" })}>
            {reading.action}
          </button>
        ) : reading.kind === "not-set-up" ? (
          <button
            type="button"
            className="primary"
            disabled={flow.host === undefined}
            onClick={() => dispatch({ type: "setup" })}
          >
            {reading.action}
          </button>
        ) : reading.kind === "set-up" || reading.kind === "folder" ? (
          <button
            type="button"
            className={reading.kind === "folder" && needsHost ? "" : "primary"}
            onClick={() => dispatch({ type: "open" })}
          >
            {reading.action}
          </button>
        ) : null}
        {reading.kind === "missing" || reading.kind === "too-new" ? (
          <button type="button" onClick={() => dispatch({ type: "back" })}>
            Choose another folder
          </button>
        ) : null}
      </div>
    </section>
  );
}

const CHILD_WORDS = { yes: "set up", no: "not set up", newer: "set up by a newer MetatorAI" } as const;

/** A dev container's folder name: its local folder's. */
const folderOf = (c: Pick<DevContainer, "localFolder">): string => folderName(c.localFolder);

const STATE_WORDS = { running: "running", stopped: "stopped" } as const;

/**
 * The Dev Container source: the containers the engine lists, each with its state and workspace
 * folder; Start for a stopped one, Choose for a running one, Refresh; then the install's progress.
 */
function Containers({
  flow,
  dispatch,
  onOpenKnown,
  output,
  onOutput,
}: {
  readonly flow: ContainerFlow;
  dispatch(e: ContainerEvent): void;
  onOpenKnown(localFolder: string): void;
  readonly output: boolean;
  onOutput(): void;
}) {
  const { known } = useRepos();
  if (flow.step === "installing" || flow.step === "installed")
    return (
      <section className="progress" data-testid="install-progress" aria-live="polite">
        <p className="busy">Installing MetatorAI in the dev container of {folderOf(flow.container)}…</p>
        <p className="line" data-testid="install-line">
          {flow.step === "installing"
            ? installLine(flow.lines)
            : `MetatorAI ${flow.version} is in the container.`}
        </p>
        <p className="dim">
          Into a folder of its own in the container ({"~/.metator/server"}); nothing else in the container
          changes.
        </p>
        {flow.step === "installing" ? <Output lines={flow.lines} open={output} onToggle={onOutput} /> : null}
      </section>
    );
  const list = flow.list;
  const reading = list ? readContainerList(list) : undefined;
  const rows = list ? containerRows(list, known) : [];
  const busy = flow.step === "listing" || flow.step === "starting";
  return (
    <section className="containers" data-testid="containers" data-kind={reading?.kind ?? "listing"}>
      <div className="containers-head">
        <h2>{reading ? reading.title : "Looking for dev containers…"}</h2>
        <button type="button" disabled={busy} onClick={() => dispatch({ type: "refresh" })}>
          {flow.step === "listing" ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {reading?.lines.map((l) => (
        <p key={l} className={reading.kind === "list" ? "dim" : ""}>
          {l}
        </p>
      ))}
      {reading && reading.links.length > 0 ? (
        <p className="links">
          {reading.links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
              {l.name}
            </a>
          ))}
        </p>
      ) : null}
      {reading?.kind === "none" ? (
        <p>
          <a href={DEVCONTAINER_DOCS} target="_blank" rel="noreferrer">
            About dev containers
          </a>
        </p>
      ) : null}
      {flow.step === "listed" && flow.error ? <p className="refusal">{flow.error}</p> : null}
      {rows.length > 0 ? (
        <ul className="container-list" data-testid="container-list">
          {rows.map((r) => (
            <li key={r.key} data-state={r.state}>
              <span className="name">{r.name}</span>
              <span className={`state ${r.state}`}>{STATE_WORDS[r.state]}</span>
              <code className="dim path" title={r.key}>
                {r.workspace || "—"}
              </code>
              {r.note ? <span className="dim note">{r.note}</span> : null}
              {r.button ? (
                <button
                  type="button"
                  className={r.action === "choose" || r.action === "open" ? "primary" : ""}
                  disabled={busy}
                  onClick={() =>
                    r.action === "start"
                      ? dispatch({ type: "start", key: r.key })
                      : r.action === "open"
                        ? onOpenKnown(r.key)
                        : dispatch({ type: "pick", key: r.key })
                  }
                >
                  {flow.step === "starting" && flow.key === r.key ? "Starting…" : r.button}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The AI host for setup: only an installed one can be chosen. */
function HostPick({
  flow,
  dispatch,
}: {
  readonly flow: Extract<Flow, { step: "inspected" }>;
  dispatch(e: FlowEvent): void;
}) {
  return (
    <fieldset className="hosts" data-testid="hosts">
      <legend>AI host</legend>
      {hostChoices(flow.inspection).map((h) => (
        <label key={h.id} className={h.enabled ? "" : "off"}>
          <input
            type="radio"
            name="host"
            value={h.id}
            disabled={!h.enabled}
            checked={flow.host === h.id}
            onChange={() => dispatch({ type: "host", host: h.id })}
          />
          {h.name}
          {h.note ? <span className="dim"> · {h.note}</span> : null}
        </label>
      ))}
    </fieldset>
  );
}

/** Setup's output: folded to one line until "Show output". */
function Output({
  lines,
  open,
  onToggle,
}: {
  readonly lines: readonly string[];
  readonly open: boolean;
  onToggle(): void;
}) {
  return (
    <div className="output">
      <button type="button" className="ghost" aria-expanded={open} onClick={onToggle}>
        {open ? "Hide output" : "Show output"}
      </button>
      {open ? <pre data-testid="setup-output">{lines.join("\n")}</pre> : null}
    </div>
  );
}

/** The browser cannot pick a folder or run a program: the commands, for a terminal. */
function WebAdd() {
  const [path, setPath] = useState("");
  const [host, setHost] = useState("claude");
  const [copied, setCopied] = useState(false);
  const lines = webCommands(path, host);
  return (
    <div className="setup-page" data-testid="add-repo-web">
      <div className="panel">
        <h1>Add repository</h1>
        <p>
          The desktop app does this for you: it picks the folder, sets it up and opens it.{" "}
          <a href={DESKTOP_DOWNLOAD} target="_blank" rel="noreferrer">
            Get the desktop app
          </a>
        </p>
        <p className="muted">Here in the browser, run these in a terminal, then come back to this page.</p>
        <div className="addr">
          <input
            aria-label="folder path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/your/repository"
          />
          <select aria-label="AI host" value={host} onChange={(e) => setHost(e.target.value)}>
            <option value="claude">Claude Code</option>
            <option value="copilot">GitHub Copilot CLI</option>
          </select>
        </div>
        <div className="cmds">
          <pre data-testid="web-commands">{lines.join("\n")}</pre>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(lines.join("\n"))
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <p className="dim">
          The second command says what it found; setup lists the files it writes; the commit is yours to make.
        </p>
        <p className="dim">A repository in a dev container is added from the desktop app.</p>
      </div>
    </div>
  );
}
