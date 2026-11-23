/**
 * Add repository (round 20, ADR-0105): pick a folder or type its path, read what the app found in
 * plain words, choose the AI host, Set up with its output as one progress line, then the commit
 * card (Commit / Not now: the commit is the person's), then Open. The steps are `flowStep`
 * (repos.ts); this screen runs the shell's command each busy step names and draws the rest. In a
 * browser it shows the commands to run instead (`WebAdd`).
 */
import { useEffect, useReducer, useRef, useState } from "react";
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
  requirements,
  START,
  shortSha,
  webCommands,
  writesFor,
} from "../repos.ts";
import { useRepos } from "../repos-context.tsx";
import { type Commands, errorText, setupWithOutput } from "../tauri-commands.ts";
import { RequirementList } from "./first-run.tsx";

export function AddRepoScreen() {
  const { commands } = useRepos();
  return commands ? <AddFlow commands={commands} /> : <WebAdd />;
}

function AddFlow({ commands }: { readonly commands: Commands }) {
  const repos = useRepos();
  const [flow, dispatch] = useReducer(flowStep, START);
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
        commands.inspectFolder(f.path).then((inspection) => say({ type: "inspected", inspection }), fail);
        break;
      case "initializing":
        commands
          .gitInit(f.inspection.path)
          .then(() => commands.inspectFolder(f.inspection.path))
          .then((inspection) => say({ type: "inspected", inspection }), fail);
        break;
      case "setting-up":
        setupWithOutput(commands, f.target, f.host, (line) => say({ type: "line", line })).then(
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
        commands
          .commitSetup(f.target, f.written)
          .then((r) => say({ type: "committed", commit: r.commit }), fail);
        break;
      case "opening":
        void addAndOpen
          .current(f.path)
          .then((why) => say(why ? { type: "failed", error: why } : { type: "opened" }));
        break;
    }
    return () => {
      live = false;
    };
  }, [step, commands]);
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
  return (
    <div className="setup-page" data-testid="add-repo">
      <div className="panel">
        <h1>Add repository</h1>
        {flow.step === "pick" ? (
          <>
            <p className="muted">Choose your repository, or a folder of repositories.</p>
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
          <div className="where">
            <code>{pathOf(flow)}</code>
            {resting ? (
              <button type="button" className="ghost" onClick={() => dispatch({ type: "back" })}>
                Change
              </button>
            ) : null}
          </div>
        )}
        {flow.step === "inspecting" ? <p className="busy">Looking at the folder…</p> : null}
        {flow.step === "inspected" ? (
          <Inspected
            flow={flow}
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
              Setting up {flow.target.split(/[\\/]/).pop()} for {hostName(flow.host)}…
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
          <p className="busy">Starting its daemon…</p>
        ) : null}
      </div>
    </div>
  );
}

/** What the inspection found, and the one next action. */
function Inspected({
  flow,
  dispatch,
  output,
  onOutput,
  onOpenKnown,
}: {
  readonly flow: Extract<Flow, { step: "inspected" }>;
  dispatch(e: FlowEvent): void;
  readonly output: boolean;
  onOutput(): void;
  onOpenKnown(path: string): void;
}) {
  const { known } = useRepos();
  const i = flow.inspection;
  const reading = readInspection(i, flow.host);
  const added = alreadyAdded(known, i);
  const retry = () => dispatch({ type: "inspect", path: i.path });
  const children = i.folder?.repos ?? [];
  const needsHost =
    reading.kind === "not-set-up" || (reading.kind === "folder" && children.some((c) => c.setUp === "no"));
  return (
    <section className="reading" data-testid="inspection" data-kind={reading.kind}>
      <h2>{added ? "Already in the app" : reading.title}</h2>
      {added ? <p>Open it; nothing is set up again.</p> : reading.lines.map((l) => <p key={l}>{l}</p>)}
      {reading.kind === "no-git" || reading.kind === "no-host" ? (
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
      </div>
    </div>
  );
}
