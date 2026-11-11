import {
  BooleanOption,
  CommandOption,
  EnumOption,
  KeybindingOption,
  ListOption,
  NumberOption,
  type OptionDefinition,
  StringOption,
} from "./options.ts";

/**
 * Every option MetatorAI knows (S1, design/13 §1). One list, read by the CLI, the daemon and the
 * app; a test keeps the keys unique and every option described with a valid default. New
 * features add their options here instead of fields in `metator.config`.
 */
const S1 = "S1";

const ui: OptionDefinition[] = [
  new EnumOption(
    {
      key: "ui.theme",
      scope: "user",
      title: "Theme",
      description: "The app's colours: follow the system, or always dark or light.",
      defaultValue: "system",
      since: S1,
    },
    ["system", "dark", "light"],
  ),
  new EnumOption(
    {
      key: "ui.density",
      scope: "user",
      title: "Density",
      description: "How tight lists and panels are.",
      defaultValue: "comfortable",
      since: S1,
    },
    ["compact", "comfortable"],
  ),
  new EnumOption(
    {
      key: "ui.paneBorders",
      scope: "user",
      title: "Pane borders",
      description: "Frames around terminal panes: only with several panes (auto), always, or never.",
      defaultValue: "auto",
      since: S1,
    },
    ["auto", "always", "off"],
  ),
  new BooleanOption({
    key: "ui.paneLabels",
    scope: "user",
    title: "Pane labels",
    description: "The agent's name and state on a pane's frame.",
    defaultValue: true,
    since: S1,
  }),
  new NumberOption(
    {
      key: "ui.sidebarWidth",
      scope: "user",
      title: "Sidebar width",
      description: "Width of the workspaces and agents sidebar.",
      defaultValue: 230,
      since: S1,
    },
    { min: 160, max: 480, unit: "px" },
  ),
  new BooleanOption({
    key: "ui.sidebarStartCollapsed",
    scope: "user",
    title: "Sidebar starts collapsed",
    description: "Open the app with the sidebar hidden; the prefix key shows it.",
    defaultValue: false,
    since: S1,
  }),
  new EnumOption(
    {
      key: "ui.panelSort",
      scope: "user",
      title: "Session order",
      description: "The sessions panel: the ones waiting for you first, or the most recently changed first.",
      defaultValue: "attention",
      since: S1,
    },
    ["attention", "updated"],
  ),
  new EnumOption(
    {
      key: "ui.statusIndicators",
      scope: "user",
      title: "State indicators",
      description: "How a pane's state is drawn: coloured dots or symbols (✓ ⋮ ! ?).",
      defaultValue: "symbols",
      since: S1,
    },
    ["dots", "symbols"],
  ),
  new BooleanOption({
    key: "ui.confirmClosePane",
    scope: "user",
    title: "Confirm closing a pane",
    description: "Ask before a pane with a live process is closed.",
    defaultValue: true,
    since: S1,
  }),
  new StringOption({
    key: "ui.windowTitle",
    scope: "user",
    title: "Window title",
    description: "Template of the window title; {workspace}, {tab} and {waiting} are filled in.",
    defaultValue: "{workspace} · {tab} · MetatorAI",
    since: S1,
  }),
  new EnumOption(
    {
      key: "ui.openOnStart",
      scope: "user",
      title: "Open on start",
      description: "The screen the app opens with: the inbox or the last one used.",
      defaultValue: "last",
      since: S1,
    },
    ["inbox", "last", "grid"],
  ),
  new EnumOption(
    {
      key: "ui.attachOnType",
      scope: "user",
      title: "Typing in an agent's pane",
      description:
        "A key typed into an agent's pane: ask to take the keyboard first, take it at once, or ignore the key.",
      defaultValue: "ask",
      since: "S6",
    },
    ["ask", "always", "never"],
  ),
];

const key = (name: string, title: string, description: string, defaultValue: readonly string[]) =>
  new KeybindingOption({ key: `keys.${name}`, scope: "user", title, description, defaultValue, since: S1 });

const keys: OptionDefinition[] = [
  key("prefix", "Prefix", "The command key: press the prefix, then one key.", ["ctrl+b"]),
  key("newShell", "New shell", "A shell pane in the tab's directory.", ["prefix+c"]),
  key("newTab", "New tab", "A tab for a task: a shell, or a run in a new worktree.", ["prefix+t"]),
  key("splitRight", "Split right", "Split the pane to the right.", ["prefix+v"]),
  key("splitDown", "Split down", "Split the pane downward.", ["prefix+-"]),
  key("zoom", "Zoom", "The pane fills the grid, and back.", ["prefix+z"]),
  key("focusLeft", "Focus left", "Move the focus to the pane on the left.", ["prefix+h", "prefix+left"]),
  key("focusDown", "Focus down", "Move the focus to the pane below.", ["prefix+j", "prefix+down"]),
  key("focusUp", "Focus up", "Move the focus to the pane above.", ["prefix+k", "prefix+up"]),
  key("focusRight", "Focus right", "Move the focus to the pane on the right.", ["prefix+l", "prefix+right"]),
  key("goto", "Go to", "The picker of agents, tabs and questions.", ["prefix+g"]),
  key("nextWaiting", "Next waiting", "The next session that waits for you.", ["prefix+n"]),
  key("attach", "Attach", "Take the keyboard of the focused pane's session.", ["prefix+a"]),
  key("release", "Release", "Give the keyboard back to the agent.", ["prefix+escape"]),
  key("copyMode", "Copy mode", "Select and search in the pane's scrollback.", ["prefix+["]),
  key("closePane", "Close pane", "Close the focused pane.", ["prefix+x"]),
  key("detach", "Detach", "Leave the client; the daemon and the panes stay.", ["prefix+q"]),
  key("plan", "Plan", "The plan of the tab's run.", ["prefix+p"]),
  key("changes", "Changes", "The tab's changes against its base, with notes.", ["prefix+r"]),
  key("backlog", "Backlog", "The repository's backlog.", ["prefix+b"]),
  key("help", "Help", "The list of keys.", ["prefix+?"]),
];

const notify: OptionDefinition[] = [
  new EnumOption(
    {
      key: "notify.channel",
      scope: "user",
      title: "Notifications",
      description:
        "Where a question for you is announced: a toast in the app, the system's notifications, a command, or nowhere.",
      defaultValue: "app",
      since: S1,
    },
    ["off", "app", "system", "command"],
  ),
  new CommandOption({
    key: "notify.command",
    scope: "repo",
    title: "Notify command",
    description:
      "A shell command run when a question waits; the question is in METATOR_QUESTION and METATOR_QUESTION_PROMPT.",
    defaultValue: 'notify-send MetatorAI "$METATOR_QUESTION_PROMPT"',
    since: S1,
    legacy: (c) => c.notify?.command,
  }),
  new NumberOption(
    {
      key: "notify.delaySeconds",
      scope: "user",
      title: "Notify after",
      description: "How long a question may wait before you are told; answered sooner, it stays quiet.",
      defaultValue: 0,
      since: S1,
    },
    { min: 0, max: 600, unit: "s" },
  ),
  new BooleanOption({
    key: "notify.sound",
    scope: "user",
    title: "Sound",
    description: "A sound with each notification.",
    defaultValue: false,
    since: S1,
  }),
];

const terminal: OptionDefinition[] = [
  new StringOption(
    {
      key: "terminal.shell",
      scope: "user",
      title: "Shell",
      description: "The shell of new shell panes; empty for the system's default.",
      defaultValue: "",
      since: S1,
    },
    { allowEmpty: true },
  ),
  new EnumOption(
    {
      key: "terminal.shellMode",
      scope: "user",
      title: "Shell mode",
      description: "Start the shell as a login shell or not; auto decides by platform.",
      defaultValue: "auto",
      since: S1,
    },
    ["auto", "login", "nonLogin"],
  ),
  new EnumOption(
    {
      key: "terminal.newPaneCwd",
      scope: "user",
      title: "New pane directory",
      description: "Where a new shell pane starts: the tab's worktree, the repository, or home.",
      defaultValue: "worktree",
      since: S1,
    },
    ["worktree", "repo", "home"],
  ),
  new NumberOption(
    {
      key: "terminal.scrollbackLines",
      scope: "user",
      title: "Scrollback",
      description: "Lines a pane keeps for copy mode and search.",
      defaultValue: 5000,
      since: S1,
    },
    { min: 200, max: 100_000, unit: "lines" },
  ),
  new NumberOption(
    {
      key: "terminal.cols",
      scope: "user",
      title: "Headless columns",
      description: "Width of a pane no client is looking at.",
      defaultValue: 120,
      since: S1,
    },
    { min: 40, max: 400 },
  ),
  new NumberOption(
    {
      key: "terminal.rows",
      scope: "user",
      title: "Headless rows",
      description: "Height of a pane no client is looking at.",
      defaultValue: 36,
      since: S1,
    },
    { min: 10, max: 200 },
  ),
];

const editor: OptionDefinition[] = [
  new CommandOption({
    key: "editor.command",
    scope: "user",
    title: "Editor",
    description:
      "The command that opens a directory or a file, e.g. code, cursor, zed, nvim; VS Code gets --goto file:line.",
    defaultValue: "code",
    since: S1,
    legacy: (c) => c.editor,
  }),
  new EnumOption(
    {
      key: "editor.openWith",
      scope: "user",
      title: "Open as",
      description: "Open a tab's worktree as the workspace of the repository, or as a plain folder.",
      defaultValue: "folder",
      since: S1,
    },
    ["workspace", "folder"],
  ),
  new StringOption(
    {
      key: "editor.diffTool",
      scope: "user",
      title: "Diff tool",
      description: "A command for a two-file diff; empty uses the editor's own.",
      defaultValue: "",
      since: S1,
    },
    { allowEmpty: true },
  ),
];

const supervisor: OptionDefinition[] = [
  new NumberOption(
    {
      key: "supervisor.wipLimit",
      scope: "repo",
      title: "Waiting limit",
      description: "How many runs may wait for a person at once before new ones start with a warning.",
      defaultValue: 4,
      since: S1,
      legacy: (c) => c.supervisor.wipLimit,
    },
    { min: 1, max: 50 },
  ),
  new BooleanOption({
    key: "supervisor.respawn",
    scope: "repo",
    title: "Respawn",
    description: "Start a session's host again when its process ends while the run is active.",
    defaultValue: true,
    since: S1,
    legacy: (c) => c.supervisor.respawn.enabled,
  }),
  new NumberOption(
    {
      key: "supervisor.respawnAttempts",
      scope: "repo",
      title: "Respawn attempts",
      description: "Restarts of one run's session before the supervisor gives up and says so.",
      defaultValue: 3,
      since: S1,
      legacy: (c) => c.supervisor.respawn.maxAttempts,
    },
    { min: 0, max: 20 },
  ),
  new NumberOption(
    {
      key: "supervisor.idleThresholdMs",
      scope: "repo",
      title: "Idle after",
      description: "No terminal output for this long, with no open question, is idleness.",
      defaultValue: 90_000,
      since: S1,
      legacy: (c) => c.supervisor.idleThresholdMs,
    },
    { min: 1000, unit: "ms" },
  ),
  new ListOption({
    key: "supervisor.hostOrder",
    scope: "repo",
    title: "Host order",
    description: "Which interactive host a new session takes first.",
    defaultValue: ["copilot", "claude", "opencode"],
    since: S1,
    restart: "daemon",
    legacy: (c) => c.supervisor.hostOrder,
  }),
  new BooleanOption({
    key: "supervisor.resumeConductors",
    scope: "repo",
    title: "Resume conductors",
    description: "After a daemon restart, bring every active run's conductor pane back.",
    defaultValue: true,
    since: S1,
    restart: "daemon",
  }),
  new NumberOption(
    {
      key: "supervisor.startupDelayMs",
      scope: "repo",
      title: "Startup delay",
      description: "How long the supervisor waits after the daemon starts before its first tick.",
      defaultValue: 2000,
      since: S1,
      restart: "daemon",
    },
    { min: 0, max: 60_000, unit: "ms" },
  ),
];

const hosts: OptionDefinition[] = [
  new StringOption(
    {
      key: "hosts.default",
      scope: "repo",
      title: "Default host",
      description: "The host of a new session when none is named; empty takes the first of the host order.",
      defaultValue: "",
      since: S1,
    },
    { allowEmpty: true },
  ),
  new StringOption({
    key: "hosts.manifestsDir",
    scope: "repo",
    title: "Host manifests",
    description: "The directory of HostManifest files that replace the shipped ones.",
    defaultValue: "metator/hosts",
    since: S1,
    restart: "daemon",
  }),
  new StringOption(
    {
      key: "hosts.models.copilot",
      scope: "repo",
      title: "Copilot model",
      description: "The model Copilot CLI sessions start with; empty for its default.",
      defaultValue: "",
      since: S1,
    },
    { allowEmpty: true },
  ),
  new StringOption(
    {
      key: "hosts.models.claude",
      scope: "repo",
      title: "Claude model",
      description: "The model Claude Code sessions start with; empty for its default.",
      defaultValue: "",
      since: S1,
    },
    { allowEmpty: true },
  ),
];

const worktrees: OptionDefinition[] = [
  new StringOption({
    key: "worktrees.directory",
    scope: "repo",
    title: "Worktrees directory",
    description: "Where a run's worktree is made, relative to the repository.",
    defaultValue: ".metator/worktrees",
    since: S1,
  }),
  new EnumOption(
    {
      key: "worktrees.removeOnClose",
      scope: "repo",
      title: "Remove on close",
      description: "What happens to a run's worktree when its tab is closed.",
      defaultValue: "ask",
      since: S1,
    },
    ["ask", "always", "never"],
  ),
  new EnumOption(
    {
      key: "worktrees.installDependencies",
      scope: "repo",
      title: "Dependencies",
      description:
        "How a new worktree gets its dependencies: copied from the repository, installed, or not at all.",
      defaultValue: "copy",
      since: S1,
    },
    ["copy", "install", "none"],
  ),
];

const review: OptionDefinition[] = [
  new BooleanOption({
    key: "review.autoOpenEditor",
    scope: "user",
    title: "Open the editor on review",
    description: "Open the worktree in the editor when the Changes screen opens.",
    defaultValue: false,
    since: "S5",
  }),
  new EnumOption(
    {
      key: "review.sendTo",
      scope: "repo",
      title: "Notes go to",
      description: "Who receives review notes: the run's conductor, or the worker that changed the lines.",
      defaultValue: "conductor",
      since: "S5",
    },
    ["conductor", "worker"],
  ),
];

const issues: OptionDefinition[] = [
  new BooleanOption({
    key: "issues.requireConsent",
    scope: "repo",
    title: "Tasks need your consent",
    description: "An agent only proposes a task; a person adds it. Always on.",
    defaultValue: true,
    since: "S4",
    fixed: true,
  }),
  new BooleanOption({
    key: "issues.proposeFromAgents",
    scope: "repo",
    title: "Agents may propose tasks",
    description: "Agents may put task proposals in the inbox; off, they can only say so in their summary.",
    defaultValue: true,
    since: "S4",
  }),
];

export const OPTIONS: readonly OptionDefinition[] = [
  ...ui,
  ...keys,
  ...notify,
  ...terminal,
  ...editor,
  ...supervisor,
  ...hosts,
  ...worktrees,
  ...review,
  ...issues,
];

export const optionByKey = (key: string): OptionDefinition | undefined => OPTIONS.find((o) => o.key === key);
