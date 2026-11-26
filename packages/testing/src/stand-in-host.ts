import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Ways a stand-in host falls short of the conformance suite, each on purpose. */
type StandInFault =
  /** Never calls a hook: the guard neither denies, nor asks, nor hears a consent. */
  | "skip-hooks"
  /** Runs a command the pre-tool hook denied. */
  | "ignore-deny"
  /** Shows its own approval even for what the hook allowed. */
  | "prompt-allowed"
  /** Resumes its session without what was said before. */
  | "forget-on-resume"
  /** Answers instead of asking the person in words. */
  | "no-text-question"
  /** Keeps working through Esc, and reads the words only when done. */
  | "ignore-interrupt";

export interface StandInHostOptions {
  /** Whose command line and hook files it plays. */
  readonly host: "claude" | "copilot";
  /** What `--version` prints. */
  readonly version?: string;
  readonly faults?: readonly StandInFault[];
}

/**
 * A stand-in for an AI host's interactive CLI (never a real one): a Bun script that takes the
 * host's command line (`claude <task> --session-id <id>` / `--resume <id>`, `copilot -i <task>` /
 * `--continue`), draws a prompt (`❯`) and Claude Code's approval menu, runs the repository's own
 * hooks (`.claude/settings.json`, `.github/hooks/metator.json`) as the host does, keeps what it
 * was told per session (a resume remembers), and answers the conformance suite's words the way
 * an agent would. The suite's logic is tested on it end to end; a fault breaks one claim on purpose.
 */
export function standInHost(dir: string, options: StandInHostOptions): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, options.host);
  writeFileSync(
    file,
    `#!/usr/bin/env bun
const HOST = ${JSON.stringify(options.host)};
const VERSION = ${JSON.stringify(options.version ?? (options.host === "claude" ? "2.1.0" : "1.0.200"))};
const FAULTS = new Set(${JSON.stringify(options.faults ?? [])});
${PROGRAM}`,
  );
  chmodSync(file, 0o755);
  return file;
}

/** The stand-in's body: plain JavaScript run by Bun in the pane's PTY. */
const PROGRAM = String.raw`
const fs = require("node:fs");
const BT = String.fromCharCode(96);
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(HOST === "claude" ? VERSION + " (Claude Code stand-in)" : "GitHub Copilot CLI " + VERSION + " (stand-in)");
  process.exit(0);
}
const STATE = path.join(path.dirname(process.argv[1]), "state");
fs.mkdirSync(STATE, { recursive: true });
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
let task = HOST === "claude" ? (args[0] && !args[0].startsWith("-") ? args[0] : undefined) : opt("-i");
let resumed = opt("--resume") ?? (args.includes("--continue") ? "latest" : undefined);
let session;
if (HOST === "claude") session = resumed ?? opt("--session-id") ?? crypto.randomUUID();
else if (resumed === "latest") { try { session = fs.readFileSync(path.join(STATE, "latest"), "utf8").trim(); } catch { session = crypto.randomUUID(); } }
else session = resumed ?? crypto.randomUUID();
if (HOST === "copilot") fs.writeFileSync(path.join(STATE, "latest"), session);
const memFile = path.join(STATE, session.replace(/[^\w-]/g, "_") + ".json");
let memory = {};
if (resumed && !FAULTS.has("forget-on-resume")) { try { memory = JSON.parse(fs.readFileSync(memFile, "utf8")); } catch {} }
const remember = () => fs.writeFileSync(memFile, JSON.stringify(memory));

const out = (s) => process.stdout.write(s);
const say = (line) => out("● " + line + "\n");
const prompt = () => out("\n❯ ");

function hooks(event) {
  try {
    if (HOST === "claude") {
      const s = JSON.parse(fs.readFileSync(".claude/settings.json", "utf8"));
      return (s.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    }
    const s = JSON.parse(fs.readFileSync(".github/hooks/metator.json", "utf8"));
    return (s.hooks?.[event] ?? []).map((h) => h.command ?? h.bash);
  } catch { return []; }
}
function hook(event, extra) {
  if (FAULTS.has("skip-hooks")) return {};
  const payload = HOST === "claude"
    ? { session_id: session, cwd: process.cwd(), hook_event_name: event, ...extra }
    : { sessionId: session, cwd: process.cwd(), ...extra };
  for (const command of hooks(event)) {
    const r = Bun.spawnSync(["sh", "-c", command], { stdin: Buffer.from(JSON.stringify(payload)), env: process.env, stdout: "pipe", stderr: "pipe" });
    const text = r.stdout.toString().trim();
    if (!text) continue;
    try {
      const o = JSON.parse(text);
      const h = o.hookSpecificOutput ?? o;
      if (h.permissionDecision) return { decision: h.permissionDecision, reason: h.permissionDecisionReason ?? "" };
    } catch {}
  }
  return {};
}

let waiting;  // what the next line answers: an approval, or the person's colour
let counting;
const queue = [];

function approval(command, then) {
  const dialog =
    "\n● Bash(" + command + ")\n  ⎿  Waiting for approval…\n\n" +
    "─".repeat(60) + "\n Bash command\n" + "╌".repeat(60) + "\n " + command + "\n" + "╌".repeat(60) + "\n" +
    " This command requires approval\n Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n\n Esc to cancel · Tab to amend\n";
  out(dialog);
  // Answered, the dialog goes from the screen as a host's redraw takes it away (its lines and the key's echo).
  const erase = "\x1b[2K\x1b[1A".repeat(dialog.split("\n").length) + "\x1b[2K\r";
  waiting = { kind: "approval", then: (yes) => { out(erase); then(yes); } };
}
function run(command) {
  const r = Bun.spawnSync(["sh", "-c", command], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const text = (r.stdout.toString() + r.stderr.toString()).trim().split("\n").slice(0, 3).join(" ").slice(0, 160);
  say("Bash(" + command + ")");
  out("  ⎿  " + (text || "(no output)") + "\n");
  return r.stdout.toString();
}
/** A shell command through the host's own rules: the pre-tool hook first. */
function tool(command, after) {
  const d = hook(HOSTEVENT.pre, HOST === "claude" ? { tool_name: "Bash", tool_input: { command } } : { toolName: "bash", toolInput: { command } });
  if (d.decision === "deny" && !FAULTS.has("ignore-deny")) {
    say("Bash(" + command + ")");
    out("  ⎿  Error: " + d.reason + "\n");
    return after(undefined);
  }
  if (d.decision === "allow" && !FAULTS.has("prompt-allowed")) return after(run(command));
  approval(command, (yes) => after(yes ? run(command) : (say("Not run: the person said no."), undefined)));
}
const HOSTEVENT = { pre: "PreToolUse", prompt: "UserPromptSubmit" };

function turn(said, done) {
  const text = said.startsWith("[metator] From the person") ? said.replace(/^\[metator\] From the person[^:]*:\s*/, "") : said;
  hook(HOSTEVENT.prompt, { prompt: said });
  const upper = /uppercase form of this word: (\w+)/.exec(text)?.[1];
  let m;
  if (/say only: Ready/.test(text)) { say("Ready."); return done(); }
  if (/You are MetatorAI's chat/.test(text)) { say("Hello. What would you like to work on?"); return done(); }
  if ((m = /Remember this code word[^:]*: (\w+)/.exec(text))) { memory.code = m[1]; remember(); say("OK"); return done(); }
  if (/What is the code word/.test(text)) { say(memory.code ? memory.code.toUpperCase() : "I do not know a code word."); return done(); }
  if (text.includes("which colour I prefer")) {
    if (FAULTS.has("no-text-question")) { say("I picked one for you: COLOUR-RED."); return done(); }
    say("Which colour do you prefer?");
    out("  a) red\n  b) blue\n  Reply with a or b.\n");
    waiting = { kind: "colour" };
    return done();
  }
  if ((m = /^commit it, with the message "([^"]+)"/.exec(text))) return tool('git commit -m "' + m[1] + '"', () => done());
  if (text.includes(BT + "metator thread show" + BT)) {
    return tool("metator thread show", (output) => {
      let title = "?";
      try { title = JSON.parse((output ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop()).data.title; } catch {}
      say(String(title).toUpperCase());
      done();
    });
  }
  if ((m = /Write the numbers from 1 to (\d+)/.exec(text))) {
    const last = Number(m[1]);
    let n = 0;
    counting = setInterval(() => {
      out(String(++n) + "\n");
      if (n >= last) { clearInterval(counting); counting = undefined; out("LIST-END\n"); done(); }
    }, 30);
    return;
  }
  const commands = [...text.matchAll(new RegExp(BT + "([^" + BT + "]+)" + BT, "g"))].map((x) => x[1]);
  if (commands.length > 0) {
    const next = () => {
      const c = commands.shift();
      if (c === undefined) { if (upper) say(upper.toUpperCase()); else say("Done."); return done(); }
      tool(c, () => next());
    };
    return next();
  }
  if (upper) { say(upper.toUpperCase()); return done(); }
  say("Noted.");
  done();
}

let busy = false;
function pump() {
  if (busy || waiting?.kind === "approval") return;
  const line = queue.shift();
  if (line === undefined) return;
  busy = true;
  setTimeout(() => turn(line, () => { busy = false; if (!waiting || waiting.kind !== "approval") prompt(); pump(); }), 60);
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.search(/[\r\n]/)) >= 0) {
    let line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.includes("\x1b")) {
      // Esc: what the agent does stops (unless it does not listen); the words after it are a new message.
      if (counting && !FAULTS.has("ignore-interrupt")) { clearInterval(counting); counting = undefined; out("Interrupted by user\n"); busy = false; }
      line = line.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b/g, "");
    }
    line = line.trim();
    if (line === "") continue;
    if (waiting?.kind === "approval") { const w = waiting; waiting = undefined; w.then(line === "1" || /^y/i.test(line)); continue; }
    if (waiting?.kind === "colour") { waiting = undefined; say("COLOUR-" + (/^b|blue/i.test(line) ? "BLUE" : "RED")); prompt(); continue; }
    queue.push(line);
    pump();
  }
});
out((HOST === "claude" ? "Claude Code (stand-in) " : "GitHub Copilot CLI (stand-in) ") + VERSION + "\n");
if (resumed) say("Resumed session " + session + ".");
if (task) { queue.push(task); pump(); } else prompt();
`;
