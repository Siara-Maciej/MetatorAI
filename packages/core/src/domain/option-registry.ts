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
 * features add their options here instead of fields in `metator.config`. An option is listed
 * only once some code reads it: a setting that changes nothing is not offered.
 */
const S1 = "S1";

const ui: OptionDefinition[] = [
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
  key(
    "newTab",
    "New tab",
    "A tab with the agent that starts a task: you say what to do, it starts the run.",
    ["prefix+t"],
  ),
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
      description: "Whether the app shows a toast for a question that waits for you.",
      defaultValue: "app",
      since: S1,
    },
    ["off", "app"],
  ),
  new CommandOption(
    {
      key: "notify.command",
      scope: "repo",
      title: "Notify command",
      description:
        "A shell command run when a question waits or a review of your request brings new threads; one readable line is in METATOR_NOTIFY_TEXT. Empty: no command runs.",
      defaultValue: "",
      since: S1,
      restart: "daemon",
      legacy: (c) => c.notify?.command,
    },
    { allowEmpty: true },
  ),
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
      restart: "daemon",
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
    restart: "daemon",
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
      restart: "daemon",
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
      restart: "daemon",
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
  ...issues,
];

export const optionByKey = (key: string): OptionDefinition | undefined => OPTIONS.find((o) => o.key === key);
