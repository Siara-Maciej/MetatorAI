/**
 * The parts of Add repository (round 20, ADR-0105): what an inspection found, the dev containers to choose from (round 21, ADR-0106), the AI host to set up with, a command's output, and the browser's version (the commands to run).
 */
import type { DevContainer } from "../../shared/platform/tauri-commands.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { CopyButton } from "../../ui/copy-button.tsx";
import {
  containerRows,
  DEVCONTAINER_DOCS,
  folderName,
  installLine,
  readContainerList,
} from "./devcontainers.ts";
import { RequirementList } from "./first-run.tsx";
import {
  alreadyAdded,
  DESKTOP_DOWNLOAD,
  type Flow,
  hostChoices,
  readInspection,
  requirements,
  type Where,
  webCommands,
  writesFor,
} from "./repos.ts";
import { reposActs, useReposOf } from "./repos-context.tsx";
import { useAddRepo, useWebAdd, WebAdd as WebAddForm } from "./state.ts";

type InspectedFlow = Extract<Flow, { step: "inspected" }>;

/** What the inspection found, and the one next action (while the flow is at that step). */
export function Inspected() {
  const flow = useAddRepo((s) => (s.flow.step === "inspected" ? s.flow : undefined));
  return flow ? <InspectedFlowOf flow={flow} /> : null;
}

function InspectedFlowOf({ flow }: { readonly flow: InspectedFlow }) {
  const known = useReposOf((r) => r.known);
  const dispatch = useAddRepo((s) => s.dispatch);
  /** The dev container's local folder label, when the folder is in one. */
  const container = useAddRepo((s) => s.place?.localFolder);
  const where: Where = container !== undefined ? "container" : "here";
  const onOpenKnown = (path: string) => void reposActs.open(path);
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
              {c.stack?.line ? (
                <span className="dim" data-testid="child-stack">
                  {c.stack.line}
                </span>
              ) : null}
              <span className="dim">{CHILD_WORDS[c.setUp]}</span>
              {c.setUp !== "no" ? null : (
                <Button
                  disabled={flow.host === undefined}
                  onClick={() => dispatch({ type: "setup", target: c.root })}
                >
                  Set up
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {!added && needsHost ? <HostPick flow={flow} /> : null}
      {flow.error ? <p className="refusal">{flow.error}</p> : null}
      {flow.lines && flow.lines.length > 0 ? <Output lines={flow.lines} /> : null}
      <div className="actions">
        {added ? (
          <Button variant="primary" onClick={() => onOpenKnown(added.path)}>
            Open
          </Button>
        ) : reading.kind === "not-repo" ? (
          <Button variant="primary" onClick={() => dispatch({ type: "git-init" })}>
            {reading.action}
          </Button>
        ) : reading.kind === "not-set-up" ? (
          <Button
            variant="primary"
            disabled={flow.host === undefined}
            onClick={() => dispatch({ type: "setup" })}
          >
            {reading.action}
          </Button>
        ) : reading.kind === "set-up" || reading.kind === "folder" ? (
          <Button
            className={reading.kind === "folder" && needsHost ? "" : "primary"}
            onClick={() => dispatch({ type: "open" })}
          >
            {reading.action}
          </Button>
        ) : null}
        {reading.kind === "missing" || reading.kind === "too-new" ? (
          <Button onClick={() => dispatch({ type: "back" })}>Choose another folder</Button>
        ) : null}
      </div>
    </section>
  );
}
const CHILD_WORDS = { yes: "set up", no: "not set up", newer: "set up by a newer MetatorAI" } as const;
const STATE_WORDS = { running: "running", stopped: "stopped" } as const;
/**
 * The Dev Container source: the containers the engine lists, each with its state and workspace
 * folder; Start for a stopped one, Choose for a running one, Refresh; then the install's progress.
 */
export function Containers() {
  const flow = useAddRepo((s) => s.boxes);
  const dispatch = useAddRepo((s) => s.box);
  const known = useReposOf((r) => r.known);
  const onOpenKnown = (localFolder: string) => {
    const k = known?.find((x) => x.devcontainer?.localFolder === localFolder);
    if (k) void reposActs.open(k.path);
  };
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
        {flow.step === "installing" ? <Output lines={flow.lines} /> : null}
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
        <Button disabled={busy} onClick={() => dispatch({ type: "refresh" })}>
          {flow.step === "listing" ? "Refreshing…" : "Refresh"}
        </Button>
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
                <Button
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
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
/** The AI host for setup: only an installed one can be chosen. */
function HostPick({ flow }: { readonly flow: InspectedFlow }) {
  const dispatch = useAddRepo((s) => s.dispatch);
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
/** Setup's output: folded to one line until "Show output" (one fold for the whole screen). */
export function Output({ lines }: { readonly lines: readonly string[] }) {
  const open = useAddRepo((s) => s.output);
  const onToggle = useAddRepo((s) => s.toggleOutput);
  return (
    <div className="output">
      <Button variant="ghost" aria-expanded={open} onClick={onToggle}>
        {open ? "Hide output" : "Show output"}
      </Button>
      {open ? <pre data-testid="setup-output">{lines.join("\n")}</pre> : null}
    </div>
  );
}
/** The browser cannot pick a folder or run a program: the commands, for a terminal. */
export function WebAdd() {
  return (
    <ScopeProvider store={WebAddForm} init={undefined}>
      <WebAddPanel />
    </ScopeProvider>
  );
}

function WebAddPanel() {
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
          <WebPathField />
          <WebHostField />
        </div>
        <WebCommands />
        <p className="dim">
          The second command says what it found; setup lists the files it writes; the commit is yours to make.
        </p>
        <p className="dim">A repository in a dev container is added from the desktop app.</p>
      </div>
    </div>
  );
}

function WebPathField() {
  const path = useWebAdd((s) => s.path);
  const typePath = useWebAdd((s) => s.typePath);
  return (
    <input
      aria-label="folder path"
      value={path}
      onChange={(e) => typePath(e.target.value)}
      placeholder="/path/to/your/repository"
    />
  );
}

function WebHostField() {
  const host = useWebAdd((s) => s.host);
  const chooseHost = useWebAdd((s) => s.chooseHost);
  return (
    <select aria-label="AI host" value={host} onChange={(e) => chooseHost(e.target.value)}>
      <option value="claude">Claude Code</option>
      <option value="copilot">GitHub Copilot CLI</option>
    </select>
  );
}

/** The commands for the path and host chosen, with Copy. */
function WebCommands() {
  const text = useWebAdd((s) => webCommands(s.path, s.host).join("\n"));
  return (
    <div className="cmds">
      <pre data-testid="web-commands">{text}</pre>
      <CopyButton text={text} />
    </div>
  );
}

/** A dev container as the person knows it: the name of its local folder. */
export const folderOf = (c: Pick<DevContainer, "localFolder">): string => folderName(c.localFolder);
