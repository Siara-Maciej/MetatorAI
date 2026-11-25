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
import { useEffect, useMemo, useReducer, useState } from "react";
import {
  asCommandError,
  type Commands,
  type DevContainer,
  errorText,
  installWithOutput,
  setupWithOutput,
} from "../../shared/platform/tauri-commands.ts";
import { useLatest } from "../../shared/use-latest.ts";
import { Button } from "../../ui/button.tsx";
import { Tabs } from "../../ui/tabs.tsx";
import { Containers, folderOf, Inspected, Output, WebAdd } from "./add-repo-parts.tsx";
import {
  type ContainerEvent,
  containerStep,
  inContainer,
  installErrorText,
  LISTING,
} from "./devcontainers.ts";
import {
  commitQuestion,
  type FlowEvent,
  flowStep,
  hostName,
  pathOf,
  progressLine,
  repoName,
  START,
  shortSha,
  type Where,
} from "./repos.ts";
import { useRepos } from "./repos-context.tsx";

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
  const now = useLatest(flow);
  const addAndOpen = useLatest(repos.addAndOpen);
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
  const boxNow = useLatest(boxes);
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
              <Button variant="primary" onClick={() => void pick()}>
                Choose folder…
              </Button>
              <input
                aria-label="folder path"
                value={flow.path}
                onChange={(e) => dispatch({ type: "type", path: e.target.value })}
                placeholder="or type its path"
              />
              <Button type="submit" disabled={flow.path.trim() === ""}>
                Continue
              </Button>
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
              <Button variant="ghost" onClick={change}>
                Change
              </Button>
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
              <Button
                variant="primary"
                disabled={flow.step === "committing"}
                onClick={() => dispatch({ type: "commit" })}
              >
                {flow.step === "committing" ? "Committing…" : "Commit"}
              </Button>
              <Button disabled={flow.step === "committing"} onClick={() => dispatch({ type: "not-now" })}>
                Not now
              </Button>
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
              <Button variant="primary" onClick={() => dispatch({ type: "open" })}>
                Open
              </Button>
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
/** A dev container's folder name: its local folder's. */
