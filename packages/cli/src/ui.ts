import { editorLaunch, KNOWN_EDITORS, preferredEditor, type ServiceReport } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { follow, person } from "./live.ts";
import { newRun, resume, sessionRows } from "./sessions.ts";
import type { Choice, Terminal } from "./terminal.ts";

export interface HubContext {
  readonly c: MetatorContainer;
  readonly terminal: Terminal;
  /** `--root` given to this command, passed on to drives it starts. */
  readonly root: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * `metator ui` (F8.6, ADR-0054): every run as a session. Pick one to watch it, answer it, run its
 * applications, open its worktree in your editor or a shell, or see its diff; start a new run;
 * answer every waiting question in one inbox. The bell rings when a new question arrives.
 */
export async function hub(h: HubContext): Promise<{ readonly visited: readonly string[] }> {
  const visited: string[] = [];
  let waitingBefore = 0;
  for (;;) {
    const rows = await sessionRows(h.c);
    const sessions = rows.isOk() ? rows.value : [];
    const waiting = sessions.reduce((n, s) => n + s.waiting, 0);
    if (waiting > waitingBefore) h.terminal.bell();
    waitingBefore = waiting;
    const choice = await h.terminal.choose<string>(
      `Sessions${waiting > 0 ? ` · ${waiting} question(s) for you` : ""}`,
      [
        ...sessions.map((s) => ({
          value: `run:${s.runId}`,
          label: `${s.runId} · ${s.stage}`,
          hint: s.state,
        })),
        { value: "new", label: "New run" },
        { value: "inbox", label: `Questions (${waiting})` },
        { value: "quit", label: "Quit" },
      ],
    );
    if (choice === null || choice === "quit") return { visited };
    if (choice === "new") {
      const r = await newRun(h.c, h.terminal, h.root);
      if (r.isErr()) h.terminal.show(`! ${r.error.message}`);
    } else if (choice === "inbox") await inbox(h);
    else {
      const runId = choice.slice(4);
      visited.push(runId);
      await session(h, runId);
    }
  }
}

/** Every open question of every run, answered one by one. */
async function inbox(h: HubContext, only?: string): Promise<void> {
  const journal = h.c.resolve("runJournal");
  for (;;) {
    const ids = only ? [only] : await h.c.resolve("runRepository").list();
    const open = [];
    for (const runId of ids) {
      const qs = await journal.questions(runId);
      if (qs.isOk()) open.push(...qs.value.filter((q) => !q.answer));
    }
    if (open.length === 0) {
      h.terminal.show("No questions are waiting.");
      return;
    }
    const picked = await h.terminal.choose<string>("Which question?", [
      ...open.map((q) => ({
        value: `${q.runId}/${q.id}`,
        label: q.prompt,
        hint: `${q.runId} · ${q.stage} · ${q.source}`,
      })),
      { value: "back", label: "Back" },
    ]);
    if (picked === null || picked === "back") return;
    const q = open.find((x) => `${x.runId}/${x.id}` === picked);
    if (!q) return;
    const answer = await h.terminal.answer(q);
    if (answer === null) continue;
    const saved = await journal.answer(q.runId, q.id, { ...answer, by: person(h.env) });
    h.terminal.show(saved.isOk() ? `↳ ${q.id}: ${answer.choices.join(", ")}` : `! ${saved.error.message}`);
  }
}

type SessionAction =
  | "watch"
  | "continue"
  | "questions"
  | "apps"
  | "editor"
  | "shell"
  | "diff"
  | "stop"
  | "back";

async function session(h: HubContext, runId: string): Promise<void> {
  for (;;) {
    const record = await h.c.resolve("runRepository").load(runId);
    if (record.isErr()) {
      h.terminal.show(`! ${record.error.message}`);
      return;
    }
    const rows = await sessionRows(h.c);
    const row = rows.isOk() ? rows.value.find((r) => r.runId === runId) : undefined;
    const active = record.value.state.status === "active";
    const actions: Choice<SessionAction>[] = [
      ...(active && row?.driving ? [{ value: "watch" as const, label: "Watch live" }] : []),
      ...(active && !row?.driving
        ? [{ value: "continue" as const, label: "Continue the run", hint: "drive it again and watch" }]
        : []),
      ...(row && row.waiting > 0
        ? [{ value: "questions" as const, label: `Answer questions (${row.waiting})` }]
        : []),
      { value: "apps", label: "Applications", hint: "start, stop, logs, open" },
      { value: "editor", label: "Open in editor" },
      { value: "shell", label: "Shell here" },
      { value: "diff", label: "Diff" },
      ...(row?.driving
        ? [{ value: "stop" as const, label: "Stop the drive", hint: "the run stays where it is" }]
        : []),
      { value: "back", label: "Back" },
    ];
    const where = workdir(h, record.value.worktree?.path);
    const action = await h.terminal.choose<SessionAction>(
      `${runId} · ${record.value.state.stage} · ${row?.state ?? record.value.state.status} · ${where}`,
      actions,
    );
    if (action === null || action === "back") return;
    if (action === "watch") await follow(h.c, runId, h.terminal, person(h.env));
    else if (action === "continue") {
      const r = await resume(h.c, h.root, runId);
      if (r.isErr()) h.terminal.show(`! ${r.error.message}`);
      else await follow(h.c, runId, h.terminal, person(h.env));
    } else if (action === "questions") await inbox(h, runId);
    else if (action === "apps") await apps(h, record.value.worktree?.id);
    else if (action === "editor") await openEditor(h, where);
    else if (action === "shell") await shell(h, where);
    else if (action === "diff") await diff(h, where, record.value.worktree !== undefined);
    else if (action === "stop") {
      const r = await h.c.resolve("runDrivers").stop(runId);
      h.terminal.show(r.isOk() ? "Stopped; continue it any time." : `! ${r.error.message}`);
    }
  }
}

function workdir(h: HubContext, worktreePath: string | undefined): string {
  const root = h.c.resolve("root");
  return worktreePath ? `${root}/${worktreePath}` : root;
}

/** The session's services: where they run, start and stop them, read their logs, open them. */
async function apps(h: HubContext, worktree: string | undefined): Promise<void> {
  const services = h.c.resolve("environmentServices");
  const target = worktree ? { worktree } : {};
  for (;;) {
    const status = await services.status(target);
    if (status.isErr()) {
      h.terminal.show(`! ${status.error.message}${status.error.hint ? ` ${status.error.hint}` : ""}`);
      return;
    }
    const label = (s: ServiceReport) =>
      `${s.service} · ${s.status} · ${
        Object.entries(s.ports)
          .map(([n, p]) => `${n} ${p}`)
          .join(", ") || "no ports"
      }`;
    const picked = await h.terminal.choose<string>(`Applications${worktree ? ` of ${worktree}` : ""}`, [
      ...status.value.map((s) => ({ value: `svc:${s.service}`, label: label(s), hint: s.scope })),
      { value: "up", label: "Start all" },
      { value: "down", label: "Stop all", hint: "shared services keep running" },
      { value: "back", label: "Back" },
    ]);
    if (picked === null || picked === "back") return;
    if (picked === "up" || picked === "down") {
      const r = picked === "up" ? await services.up(target) : await services.down(target);
      h.terminal.show(r.isOk() ? (picked === "up" ? "Started." : "Stopped.") : `! ${r.error.message}`);
      continue;
    }
    const report = status.value.find((s) => `svc:${s.service}` === picked);
    if (!report) continue;
    const port = Object.values(report.ports)[0];
    const what = await h.terminal.choose<string>(label(report), [
      { value: "start", label: "Start" },
      { value: "stop", label: "Stop" },
      { value: "logs", label: "Logs" },
      ...(report.status === "running" && port
        ? [{ value: "open", label: `Open http://127.0.0.1:${port}` }]
        : []),
      { value: "back", label: "Back" },
    ]);
    if (what === "start") {
      const r = await services.up({ ...target, services: [report.service] });
      h.terminal.show(r.isOk() ? `${report.service} is up.` : `! ${r.error.message}`);
    } else if (what === "stop") {
      const r = await services.down({
        ...target,
        services: [report.service],
        shared: report.scope === "shared",
      });
      h.terminal.show(r.isOk() ? `${report.service} stopped.` : `! ${r.error.message}`);
    } else if (what === "logs") {
      const r = await services.logs({ ...target, service: report.service, lines: 30 });
      h.terminal.show(r.isOk() ? r.value || "(no output yet)" : `! ${r.error.message}`);
    } else if (what === "open") {
      const url = `http://127.0.0.1:${port}`;
      const opener = h.c.resolve("launcher").available(["xdg-open", "open"])[0];
      if (opener) await h.c.resolve("launcher").detached([opener, url], h.c.resolve("root"));
      h.terminal.show(opener ? `Opened ${url}` : `Open ${url} in your browser.`);
    }
  }
}

/** Opens the directory in the person's editor; the first time, picks one and saves it. */
async function openEditor(h: HubContext, dir: string): Promise<void> {
  const launcher = h.c.resolve("launcher");
  let editor = preferredEditor(h.c.resolve("config").config.editor, h.env);
  if (!editor) {
    const found = launcher.available(KNOWN_EDITORS.map((e) => e.command));
    if (found.length === 0) {
      h.terminal.show("No editor found on PATH. Set $EDITOR, or `editor:` in metator.config.yml.");
      return;
    }
    const picked = await h.terminal.choose<string>(
      "Which editor? (saved in metator.config.yml)",
      found.map((cmd) => ({
        value: cmd,
        label: KNOWN_EDITORS.find((e) => e.command === cmd)?.label ?? cmd,
        hint: cmd,
      })),
    );
    if (!picked) return;
    const saved = await h.c.resolve("setEditor").execute({ editor: picked });
    h.terminal.show(
      saved.isOk() ? `Saved editor: ${picked} (${saved.value.file})` : `! ${saved.error.message}`,
    );
    editor = picked;
  }
  const launch = editorLaunch(editor, dir);
  const r = launch.attached
    ? await launcher.attached(launch.argv, dir)
    : await launcher.detached(launch.argv, dir);
  h.terminal.show(r.isOk() ? `Opened ${dir} in ${editor}` : `! ${r.error.message}`);
}

async function shell(h: HubContext, dir: string): Promise<void> {
  h.terminal.show(`Shell in ${dir}; exit it to come back.`);
  const r = await h.c.resolve("launcher").attached([h.env.SHELL ?? "sh"], dir);
  if (r.isErr()) h.terminal.show(`! ${r.error.message}`);
}

/** What the run changed: in a worktree, everything since it branched off this checkout's HEAD. */
async function diff(h: HubContext, dir: string, inWorktree: boolean): Promise<void> {
  const root = h.c.resolve("root");
  let base = "HEAD";
  if (inWorktree) {
    const head = await h.c.resolve("processRunner").run({ argv: ["git", "rev-parse", "HEAD"], cwd: root });
    const mb = await h.c
      .resolve("processRunner")
      .run({ argv: ["git", "merge-base", "HEAD", head.stdout.trim()], cwd: dir });
    if (mb.exitCode === 0) base = mb.stdout.trim();
  }
  const stat = await h.c.resolve("processRunner").run({ argv: ["git", "diff", "--stat", base], cwd: dir });
  h.terminal.show(stat.stdout.trim() || "No changes.");
  if (stat.stdout.trim()) await h.c.resolve("launcher").attached(["git", "diff", base], dir);
}
