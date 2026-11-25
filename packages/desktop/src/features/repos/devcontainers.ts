/**
 * Dev Containers in the app (round 21, ADR-0106), pure: what the engine's list means in plain
 * words, the rows of Add repository's "Dev Container" source and what each offers, the steps
 * before the round-20 flow takes over (Start, pick, install with progress), the panel of a
 * container that stopped, and where "open in editor" goes for a repository in a container. The
 * screens (`screens/add-repo.tsx`, `components/container-down.tsx`) draw what these say.
 */

import { plural } from "../../shared/model/format.ts";
import type {
  Commands,
  ContainerEngine,
  DevContainer,
  DevContainerList,
  KnownRepo,
} from "../../shared/platform/tauri-commands.ts";
import { type ContainerStates, containerStateOf, progressLine, repoName } from "./repos.ts";

/** Where a container engine comes from: the app needs one of them running on this computer. */
export const ENGINE_LINKS: readonly { readonly name: string; readonly url: string }[] = [
  { name: "Docker Desktop", url: "https://docs.docker.com/desktop/" },
  { name: "Rancher Desktop", url: "https://docs.rancherdesktop.io/getting-started/installation/" },
];

/** How a dev container comes to exist (outside the app). */
export const DEVCONTAINER_DOCS = "https://code.visualstudio.com/docs/devcontainers/containers";

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1).replace(/[.\s]+$/, "");

/** The engine in a person's words. */
export function engineText(e: ContainerEngine): string {
  const program = e.program === "docker" ? "docker" : "nerdctl";
  return e.context ? `${program} (context ${e.context})` : program;
}

/** What the engine's list is, as the screen says it. */
export interface ListReading {
  readonly kind: "no-engine" | "none" | "list";
  readonly title: string;
  readonly lines: readonly string[];
  /** Where to get an engine; only when there is none. */
  readonly links: readonly { readonly name: string; readonly url: string }[];
}

export function readContainerList(list: DevContainerList): ListReading {
  if (!list.engine)
    return {
      kind: "no-engine",
      title: "No container engine found",
      lines: [
        "The app reaches dev containers through Docker Desktop or Rancher Desktop on this computer, and neither answered.",
        ...(list.problem ? [`${capital(list.problem)}.`] : []),
        "Install one, or start it if it is installed, then press Refresh.",
      ],
      links: ENGINE_LINKS,
    };
  if (list.containers.length === 0)
    return {
      kind: "none",
      title: "No dev container yet",
      lines: [
        `${engineText(list.engine)} answers, but no container was made by Dev Containers.`,
        "Open your repository once in VS Code (Reopen in Container), or run devcontainer up, then press Refresh.",
      ],
      links: [],
    };
  return {
    kind: "list",
    title: `${plural(list.containers.length, "dev container")} on this computer`,
    lines: [`Found through ${engineText(list.engine)}.`],
    links: [],
  };
}

/** What a container's row offers. */
export type RowAction = "start" | "choose" | "open" | "none";

export interface ContainerRow {
  /** The local folder label: the container's identity. */
  readonly key: string;
  /** The local folder's name. */
  readonly name: string;
  readonly state: "running" | "stopped";
  /** The workspace folder inside it; "" when the engine found none. */
  readonly workspace: string;
  readonly action: RowAction;
  /** The button's words; undefined with no action. */
  readonly button: string | undefined;
  /** A dim line: already in the app, or why it cannot be chosen. */
  readonly note: string;
}

const BUTTON: Readonly<Record<RowAction, string | undefined>> = {
  start: "Start",
  choose: "Choose",
  open: "Open",
  none: undefined,
};

/** A folder's name, from a Windows or a POSIX path. */
export const folderName = (path: string): string =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;

/**
 * The rows of the list, by name: a stopped container offers Start; a running one Choose, or Open
 * when the app knows it already; one with no workspace folder cannot be chosen.
 */
export function containerRows(
  list: DevContainerList,
  known: readonly KnownRepo[] | undefined,
): ContainerRow[] {
  return [...list.containers]
    .sort(
      (a, b) =>
        folderName(a.localFolder).localeCompare(folderName(b.localFolder)) ||
        a.localFolder.localeCompare(b.localFolder),
    )
    .map((c) => {
      const added = known?.some((k) => k.devcontainer?.localFolder === c.localFolder) ?? false;
      const action: RowAction =
        c.state === "stopped" ? "start" : added ? "open" : c.workspaceFolder ? "choose" : "none";
      const note = added
        ? "already in the app"
        : c.state === "running" && !c.workspaceFolder
          ? "no workspace folder found in it"
          : "";
      return {
        key: c.localFolder,
        name: folderName(c.localFolder),
        state: c.state,
        workspace: c.workspaceFolder ?? "",
        action,
        button: BUTTON[action],
        note,
      };
    });
}

/** The local folder label of each listed container, with its state (the switcher's words). */
export function statesOf(list: DevContainerList | undefined): ContainerStates | undefined {
  if (!list?.engine) return undefined;
  return Object.fromEntries(list.containers.map((c) => [c.localFolder, c.state]));
}

/**
 * The steps of the "Dev Container" source, before the round-20 flow takes over in the container:
 * list → (Start) → pick → install with its lines → installed (the flow inspects the workspace).
 */
export type ContainerFlow =
  | { readonly step: "listing"; readonly list?: DevContainerList | undefined }
  | { readonly step: "listed"; readonly list: DevContainerList; readonly error?: string | undefined }
  | { readonly step: "starting"; readonly list: DevContainerList; readonly key: string }
  | {
      readonly step: "installing";
      readonly list: DevContainerList;
      readonly container: DevContainer;
      readonly lines: readonly string[];
    }
  | {
      readonly step: "installed";
      readonly list: DevContainerList;
      readonly container: DevContainer;
      readonly version: string;
    };

export type ContainerEvent =
  | { readonly type: "refresh" }
  | { readonly type: "listed"; readonly list: DevContainerList }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "start"; readonly key: string }
  | { readonly type: "started"; readonly container: DevContainer }
  | { readonly type: "pick"; readonly key: string }
  | { readonly type: "line"; readonly line: string }
  | { readonly type: "installed"; readonly version: string }
  | { readonly type: "back" };

export const LISTING: ContainerFlow = { step: "listing" };

const NO_LIST: DevContainerList = { engine: null, containers: [], problem: null };

/** The container flow's one transition function: an event that does not fit the step changes nothing. */
export function containerStep(s: ContainerFlow, e: ContainerEvent): ContainerFlow {
  switch (e.type) {
    case "refresh":
      return s.step === "listed" ? { step: "listing", list: s.list } : s;
    case "listed":
      return s.step === "listing" ? { step: "listed", list: e.list } : s;
    case "failed":
      switch (s.step) {
        case "listing":
          return { step: "listed", list: s.list ?? NO_LIST, error: e.error };
        case "starting":
        case "installing":
          return { step: "listed", list: s.list, error: e.error };
        default:
          return s;
      }
    case "start": {
      if (s.step !== "listed") return s;
      const c = s.list.containers.find((x) => x.localFolder === e.key);
      return c?.state === "stopped" ? { step: "starting", list: s.list, key: e.key } : s;
    }
    case "started": {
      if (s.step !== "starting") return s;
      const containers = s.list.containers.map((c) =>
        c.localFolder === e.container.localFolder ? e.container : c,
      );
      return { step: "listed", list: { ...s.list, containers } };
    }
    case "pick": {
      if (s.step !== "listed") return s;
      const c = s.list.containers.find((x) => x.localFolder === e.key);
      // Only a running container with a workspace folder: a stopped one is started first.
      return c?.state === "running" && c.workspaceFolder
        ? { step: "installing", list: s.list, container: c, lines: [] }
        : s;
    }
    case "line":
      return s.step === "installing" ? { ...s, lines: [...s.lines, e.line] } : s;
    case "installed":
      return s.step === "installing"
        ? { step: "installed", list: s.list, container: s.container, version: e.version }
        : s;
    case "back":
      return s.step === "installed" ? { step: "listed", list: s.list } : s;
  }
}

/** The one line of a running install: its last line with words, else that it started. */
export const installLine = (lines: readonly string[]): string =>
  progressLine(lines, "Connecting to the container…");

/** Why an install failed, in words: Alpine (musl) is named, the rest is the shell's sentence. */
export function installErrorText(
  e: { readonly code: string; readonly message: string },
  text: string,
): string {
  if (e.code === "MUSL")
    return "This container is Alpine-based (musl). MetatorAI's Linux build needs glibc: use a Debian or Ubuntu based image for the dev container.";
  return text;
}

/** The round-20 flow's commands, each run in this dev container. */
export type FlowCommands = Pick<
  Commands,
  "inspectFolder" | "runSetup" | "onSetup" | "gitInit" | "commitSetup"
>;

export function inContainer(commands: FlowCommands, localFolder: string): FlowCommands {
  return {
    inspectFolder: (path) => commands.inspectFolder(path, localFolder),
    runSetup: (path, host) => commands.runSetup(path, host, localFolder),
    onSetup: (listener) => commands.onSetup(listener),
    gitInit: (path) => commands.gitInit(path, localFolder),
    commitSetup: (path, files) => commands.commitSetup(path, files, localFolder),
  };
}

/** The panel of a dev container the window lost: what happened, and Start and/or Reconnect. */
export interface DownPanel {
  readonly title: string;
  readonly lines: readonly string[];
  readonly start: boolean;
  readonly reconnect: boolean;
}

export function containerDown(
  current: Pick<KnownRepo, "name" | "kind" | "devcontainer">,
  states: ContainerStates | undefined,
): DownPanel {
  const name = repoName(current);
  switch (containerStateOf(current, states)) {
    case "stopped":
      return {
        title: "The container stopped",
        lines: [`${name} runs in a dev container, and it is stopped. Start it; the app reconnects.`],
        start: true,
        reconnect: true,
      };
    case "running":
      return {
        title: "The link to the container dropped",
        lines: [`The dev container of ${current.name} runs. Reconnect to start its daemon again.`],
        start: false,
        reconnect: true,
      };
    case "missing":
      return {
        title: "The container is not there",
        lines: [
          `No dev container of ${current.devcontainer?.localFolder ?? current.name} was found. Open it once in VS Code, or run devcontainer up, then press Reconnect.`,
        ],
        start: false,
        reconnect: true,
      };
    default:
      return {
        title: "The container does not answer",
        lines: [`${name} runs in a dev container the app cannot reach. Start it, or Reconnect.`],
        start: true,
        reconnect: true,
      };
  }
}

/**
 * Where the editor opens when it is not the daemon's: for a repository in a dev container, the
 * request that opens VS Code on this computer (answered like a daemon's action); undefined when
 * the daemon opens it.
 */
export type HostEditor = (
  at: EditorAt,
) =>
  | (() => Promise<{ readonly ok: boolean; readonly error?: { readonly message?: string } | undefined }>)
  | undefined;

/** Where "open in editor" goes: the daemon's editor, or a link opened on this computer. */
export type EditorChoice =
  | { readonly kind: "daemon" }
  | { readonly kind: "host"; readonly uri: string }
  | { readonly kind: "none"; readonly why: string };

/** A place to open: a pane's directory, or a run's worktree (relative to the repository), a file and line. */
export interface EditorAt {
  readonly cwd?: string | undefined;
  readonly worktree?: string | undefined;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
}

const joinPath = (dir: string, rel: string): string =>
  rel.startsWith("/") ? rel : `${dir.replace(/\/+$/, "")}/${rel.replace(/^\.?\/+/, "")}`;

/**
 * A repository on this computer opens in the daemon's editor (`editor.command`). One in a dev
 * container opens VS Code on this computer, attached to the container, through the engine's link
 * (`vscode://vscode-remote/dev-container+<hex>`) and the path inside the container: never an
 * editor inside the container.
 */
export function editorChoice(current: KnownRepo | undefined, at: EditorAt): EditorChoice {
  if (current?.kind !== "devcontainer") return { kind: "daemon" };
  const c = current.devcontainer;
  if (!c?.editorUri) return { kind: "none", why: "the app has no editor link for this dev container" };
  const dir = at.cwd ?? (at.worktree ? joinPath(c.workspaceFolder, at.worktree) : c.workspaceFolder);
  const path = at.file ? joinPath(dir, at.file) : dir;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const line = at.file && at.line ? `:${at.line}` : "";
  return { kind: "host", uri: `${c.editorUri.replace(/\/+$/, "")}${encoded}${line}` };
}
