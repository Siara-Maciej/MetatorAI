/**
 * What an agent may not do to herdr (E1, ADR-0079). herdr lets any process in any pane drive any
 * other pane; MetatorAI's hooks refuse the commands that would let one agent act for a person or
 * for another agent: typing into a pane (an approval prompt answered by someone else), starting
 * agents outside a run, planting a command herdr runs after a restart, installing plugins,
 * closing work, and reaching herdr's socket around its CLI. Reading, listing and waiting stay open.
 */

/** Why each refused command is refused, said to the agent (it reads the reason and adapts). */
export const HERDR_REFUSALS = {
  input:
    "typing into a herdr pane can answer another agent's approval prompt; only a person does that. To tell another run something, use `metator run message <run> --text …`.",
  prompt:
    "prompting another agent through herdr is an instruction outside its run; send it data with `metator run message <run> --text …` instead.",
  start: "agents start inside a MetatorAI run (`metator herdr open --run <id>`), not on their own.",
  resume:
    "a resume command reported to herdr runs again after a server restart; only the host's own integration reports it.",
  plugins: "herdr plugins run as the user with no sandbox; a person installs or changes them.",
  close:
    "closing herdr workspaces, tabs, panes, sessions or the server ends other people's work; ask the user.",
  trust: "trusting a repository for git is the user's decision after they checked it; ask the user.",
  machines: "saved SSH machines and herdr updates are the user's to change.",
  socket:
    "herdr's socket bypasses its CLI and these rules; use `herdr` commands that only read (list, get, read, wait).",
} as const;

export type HerdrRefusal = keyof typeof HERDR_REFUSALS;

/** Global options of the herdr CLI that take a value and come before the command. */
const GLOBAL_WITH_VALUE = new Set(["--session", "--machine", "--remote"]);

/** Which `herdr <group> <verb>` an agent may not run, and why. */
const REFUSED: Readonly<Record<string, Readonly<Record<string, HerdrRefusal>>>> = {
  agent: { "send-keys": "input", prompt: "prompt", start: "start", attach: "input" },
  pane: {
    "send-text": "input",
    "send-keys": "input",
    "send-input": "input",
    run: "input",
    input: "input",
    close: "close",
    "report-agent": "resume",
    "report-agent-session": "resume",
    "release-agent": "resume",
  },
  terminal: { attach: "input" },
  plugin: {
    install: "plugins",
    update: "plugins",
    uninstall: "plugins",
    link: "plugins",
    unlink: "plugins",
    enable: "plugins",
    disable: "plugins",
  },
  integration: { install: "plugins", uninstall: "plugins" },
  workspace: { close: "close" },
  tab: { close: "close" },
  worktree: { remove: "close" },
  session: { stop: "close", delete: "close", attach: "input" },
  server: { stop: "close", "live-handoff": "close" },
  machine: { add: "machines", remove: "machines", enable: "machines", disable: "machines" },
};

/** Groups whose every verb is refused. */
const REFUSED_GROUP: Readonly<Record<string, HerdrRefusal>> = { update: "machines" };

const isHerdr = (word: string | undefined) => word !== undefined && /(^|[\\/])herdr(\.exe)?$/.test(word);

/** Words that run the command after them: `env X=1 herdr …`, `timeout 5 herdr …`, `xargs herdr …`. */
const WRAPPERS = new Set([
  "env",
  "command",
  "exec",
  "nohup",
  "sudo",
  "time",
  "timeout",
  "xargs",
  "nice",
  "stdbuf",
]);

/** Where the program of a simple command is: past wrappers, their options, values and assignments. */
function programAt(argv: readonly string[]): number {
  let i = 0;
  while (i < argv.length) {
    const w = argv[i] as string;
    const wrapped = WRAPPERS.has(w.replace(/^.*[\\/]/, ""));
    if (
      !wrapped &&
      !(i > 0 && (w.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^\d+[smh]?$/.test(w)))
    )
      return i;
    i++;
  }
  return i;
}

/**
 * Why a shell command must not run, when it drives herdr in a refused way; undefined otherwise.
 * `argvs` are the command's simple commands (as `commandsOf` splits them); `raw` is the command
 * text, for what parsing hides: `"$HERDR_BIN_PATH" …` parses to an empty word, and a socket
 * reached with `nc -U` or `socat` does not name herdr at all.
 */
export function herdrRefusal(argvs: readonly (readonly string[])[], raw: string): HerdrRefusal | undefined {
  if (/HERDR_SOCKET_PATH|herdr(-client)?\.sock|\\pipe\\[^\s]*herdr/i.test(raw)) return "socket";
  const viaEnv = /HERDR_BIN_PATH/.test(raw);
  for (const argv of argvs) {
    // MetatorAI's own way into herdr is a person's too: opening starts an agent, closing ends work.
    const metator = argv.findIndex(
      (a) => a === "metator" || a.endsWith("/metator") || a.endsWith("cli/src/main.ts"),
    );
    if (metator >= 0 && argv[metator + 1] === "herdr") {
      if (argv[metator + 2] === "open") return "start";
      if (argv[metator + 2] === "close") return "close";
    }
    const at = programAt(argv);
    const program = argv[at];
    if (!(isHerdr(program) || (viaEnv && program === ""))) continue;
    const words: string[] = [];
    for (let i = at + 1; i < argv.length; i++) {
      const w = argv[i] as string;
      if (w === "--trust-repository") return "trust";
      if (GLOBAL_WITH_VALUE.has(w) && words.length === 0) {
        i++;
        continue;
      }
      if (w.startsWith("-")) continue;
      words.push(w);
    }
    if (argv.includes("--trust-repository")) return "trust";
    const [group, verb] = words;
    if (group === undefined) continue;
    const whole = REFUSED_GROUP[group];
    if (whole) return whole;
    const refusal = verb === undefined ? undefined : REFUSED[group]?.[verb];
    if (refusal) return refusal;
  }
  return undefined;
}
