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
 *
 * The screen only lays its parts out (ADR-0113): what it keeps is the AddRepo store (`state.ts`),
 * and each part reads only the value it draws, so typing a path draws the field and Continue.
 */
import { useEffect, useMemo } from "react";
import {
  asCommandError,
  type Commands,
  errorText,
  installWithOutput,
  setupWithOutput,
} from "../../shared/platform/tauri-commands.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Tabs } from "../../ui/tabs.tsx";
import { Containers, folderOf, Inspected, Output, WebAdd } from "./add-repo-parts.tsx";
import { type ContainerEvent, inContainer, installErrorText } from "./devcontainers.ts";
import {
  commitQuestion,
  type FlowEvent,
  hostName,
  pathOf,
  progressLine,
  repoName,
  shortSha,
} from "./repos.ts";
import { reposActs, useReposOf } from "./repos-context.tsx";
import { AddRepo, isPicking, type Source, useAddRepo, useAddRepoApi } from "./state.ts";

const SOURCES: readonly { readonly id: Source; readonly label: string }[] = [
  { id: "folder", label: "Folder on this computer" },
  { id: "repos", label: "Folder of repositories" },
  { id: "devcontainer", label: "Dev Container" },
];
export function AddRepoScreen() {
  const commands = useReposOf((r) => r.commands);
  return commands ? <AddFlow commands={commands} /> : <WebAdd />;
}
function AddFlow({ commands }: { readonly commands: Commands }) {
  return (
    <ScopeProvider store={AddRepo} init={{ commands }}>
      <FlowRunner commands={commands} />
      <BoxRunner commands={commands} />
      <div className="setup-page" data-testid="add-repo">
        <div className="panel">
          <h1>Add repository</h1>
          <SourceTabs />
          <PickOrWhere />
          <PlaceError />
          <Inspecting />
          <InspectedStep />
          <Initializing />
          <SettingUp />
          <CommitCard />
          <Ready />
          <Opening />
        </div>
      </div>
    </ScopeProvider>
  );
}

/** Each busy step runs its one command; what it answers is the next event. Draws nothing. */
function FlowRunner({ commands }: { readonly commands: Commands }) {
  const api = useAddRepoApi();
  const step = useAddRepo((s) => s.flow.step);
  const place = useAddRepo((s) => s.place);
  const run = useMemo(() => (place ? inContainer(commands, place.localFolder) : commands), [commands, place]);
  useEffect(() => {
    void step;
    const f = api.getState().flow;
    let live = true;
    const say = (e: FlowEvent) => {
      if (live) api.getState().dispatch(e);
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
        void reposActs
          .addAndOpen(f.path, place?.localFolder)
          .then((why) => say(why ? { type: "failed", error: why } : { type: "opened" }));
        break;
    }
    return () => {
      live = false;
    };
  }, [step, run, place, api]);
  return null;
}

/** The Dev Container source's busy steps, the same way: list, start, install. Draws nothing. */
function BoxRunner({ commands }: { readonly commands: Commands }) {
  const api = useAddRepoApi();
  const boxStep = useAddRepo((s) => (s.source === "devcontainer" ? s.boxes.step : undefined));
  useEffect(() => {
    void boxStep;
    const b = api.getState().boxes;
    let live = true;
    const say = (e: ContainerEvent) => {
      if (live) api.getState().box(e);
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
        api.getState().installed(b.container);
        break;
    }
    return () => {
      live = false;
    };
  }, [boxStep, commands, api]);
  return null;
}

function SourceTabs() {
  const shown = useAddRepo(
    (s) =>
      isPicking(s) &&
      !(s.source === "devcontainer" && (s.boxes.step === "installing" || s.boxes.step === "installed")),
  );
  const source = useAddRepo((s) => s.source);
  const choose = useAddRepo((s) => s.choose);
  return shown ? (
    <Tabs
      label="where the repository is"
      items={SOURCES}
      current={source}
      onSelect={(id) => choose(id)}
      className="tabs sources"
      testId="sources"
    />
  ) : null;
}

/** The first step: the dev containers, or the folder; past it, where the flow is. */
function PickOrWhere() {
  const picking = useAddRepo(isPicking);
  const source = useAddRepo((s) => s.source);
  if (picking && source === "devcontainer") return <Containers />;
  return picking ? <PickFolder /> : <Where />;
}

function PickFolder() {
  const source = useAddRepo((s) => s.source);
  const api = useAddRepoApi();
  return (
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
          const { flow, dispatch } = api.getState();
          dispatch({ type: "inspect", path: flow.step === "pick" ? flow.path : "" });
        }}
      >
        <Button variant="primary" onClick={() => void api.getState().pick()}>
          Choose folder…
        </Button>
        <PathField />
        <ContinueButton />
      </form>
      <PickErrors />
    </>
  );
}

/** The path being typed, while the flow is at its first step. */
const typedPath = (s: { readonly flow: { readonly step: string; readonly path?: string } }): string =>
  s.flow.step === "pick" ? (s.flow.path ?? "") : "";

export function PathField() {
  const path = useAddRepo(typedPath);
  const dispatch = useAddRepo((s) => s.dispatch);
  return (
    <input
      aria-label="folder path"
      value={path}
      onChange={(e) => dispatch({ type: "type", path: e.target.value })}
      placeholder="or type its path"
    />
  );
}

export function ContinueButton() {
  const blank = useAddRepo((s) => typedPath(s).trim() === "");
  return (
    <Button type="submit" disabled={blank}>
      Continue
    </Button>
  );
}

export function PickErrors() {
  const error = useAddRepo((s) => (s.flow.step === "pick" ? s.flow.error : undefined));
  const pickError = useAddRepo((s) => s.pickError);
  return (
    <>
      {error ? <p className="refusal">{error}</p> : null}
      {pickError ? <p className="refusal">{pickError}</p> : null}
    </>
  );
}

function Where() {
  const place = useAddRepo((s) => s.place);
  const path = useAddRepo((s) => pathOf(s.flow));
  const canChange = useAddRepo(
    (s) =>
      s.flow.step === "inspected" ||
      s.flow.step === "ready" ||
      (s.place !== undefined && s.flow.step === "pick"),
  );
  const change = useAddRepo((s) => s.change);
  return (
    <div className="where" data-testid="where">
      {place ? (
        <span className="dim">{repoName({ name: folderOf(place), kind: "devcontainer" })}</span>
      ) : null}
      <code>{path}</code>
      {canChange ? (
        <Button variant="ghost" onClick={change}>
          Change
        </Button>
      ) : null}
    </div>
  );
}

/** In a container, a refusal at the first step shows under where the flow is. */
function PlaceError() {
  const error = useAddRepo((s) => (s.place && s.flow.step === "pick" ? s.flow.error : undefined));
  return error ? <p className="refusal">{error}</p> : null;
}

function Inspecting() {
  const on = useAddRepo((s) => s.flow.step === "inspecting");
  const inContainerNow = useAddRepo((s) => s.place !== undefined);
  return on ? (
    <p className="busy">
      {inContainerNow ? "Looking at the folder in the container…" : "Looking at the folder…"}
    </p>
  ) : null;
}

function InspectedStep() {
  const on = useAddRepo((s) => s.flow.step === "inspected");
  return on ? <Inspected /> : null;
}

function Initializing() {
  const on = useAddRepo((s) => s.flow.step === "initializing");
  return on ? <p className="busy">Running git init…</p> : null;
}

function SettingUp() {
  const flow = useAddRepo((s) => (s.flow.step === "setting-up" ? s.flow : undefined));
  const inContainerNow = useAddRepo((s) => s.place !== undefined);
  return flow ? (
    <section className="progress" data-testid="setup-progress" aria-live="polite">
      <p className="busy">
        Setting up {flow.target.split(/[\\/]/).pop()} for {hostName(flow.host)}
        {inContainerNow ? " in the container" : ""}…
      </p>
      <p className="line" data-testid="progress-line">
        {progressLine(flow.lines)}
      </p>
      <Output lines={flow.lines} />
    </section>
  ) : null;
}

function CommitCard() {
  const flow = useAddRepo((s) =>
    s.flow.step === "set-up" || s.flow.step === "committing" ? s.flow : undefined,
  );
  const dispatch = useAddRepo((s) => s.dispatch);
  return flow ? (
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
        Only these files go in the commit, with the message “Set up MetatorAI”. Your other changes stay as
        they are.
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
      <Output lines={flow.lines} />
    </section>
  ) : null;
}

function Ready() {
  const flow = useAddRepo((s) => (s.flow.step === "ready" ? s.flow : undefined));
  const dispatch = useAddRepo((s) => s.dispatch);
  return flow ? (
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
  ) : null;
}

function Opening() {
  const on = useAddRepo((s) => s.flow.step === "opening" || s.flow.step === "open");
  const inContainerNow = useAddRepo((s) => s.place !== undefined);
  return on ? (
    <p className="busy">
      {inContainerNow ? "Starting its daemon in the container…" : "Starting its daemon…"}
    </p>
  ) : null;
}
