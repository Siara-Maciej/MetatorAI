import type { Conversation, HostTarget, Question, RunActivity, RunOverview } from "@metator/core";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatView } from "./components/ChatView.tsx";
import {
  AnswerDialog,
  AskDialog,
  GateDialog,
  NewRunDialog,
  Palette,
  type PaletteCommand,
  SettingsDialog,
} from "./components/Dialogs.tsx";
import { RunDetail, TABS, type Tab } from "./components/RunDetail.tsx";
import { SessionList } from "./components/SessionList.tsx";
import { type Row, rowsOf, type Snapshot, selectable, totals } from "./model.ts";
import type { Launch, Settings, TuiService } from "./service.ts";

/** How `metator ui` ends a screen: quit, or give the terminal to a program and come back. */
export type Exit =
  | { readonly kind: "quit"; readonly visited: readonly string[] }
  | { readonly kind: "launch"; readonly launch: Launch; readonly state: Kept };

/** What survives a program run in the whole terminal (an editor, a shell, a diff). */
export interface Kept {
  readonly selected?: string;
  readonly tab: Tab;
  readonly visited: readonly string[];
}

type Dialog =
  | { readonly kind: "answer"; readonly repo: string; readonly question: Question }
  | { readonly kind: "gate"; readonly repo: string; readonly run: RunOverview }
  | { readonly kind: "new" }
  | { readonly kind: "ask"; readonly repo: string; readonly conversation?: string }
  | { readonly kind: "settings"; readonly repo: string; readonly settings: Settings }
  | { readonly kind: "palette" };

export interface AppProps {
  readonly service: TuiService;
  readonly kept?: Kept;
  readonly onExit: (e: Exit) => void;
  /** How often the overview is read again. */
  readonly refreshMs?: number;
  /** Rings the terminal bell (a new question waits). */
  readonly bell?: () => void;
}

const COMMANDS: readonly PaletteCommand[] = [
  { id: "answer", label: "Answer the selected run's question", key: "a" },
  { id: "continue", label: "Continue the selected run (drive it)", key: "c" },
  { id: "stop", label: "Stop the selected run's drive", key: "x" },
  { id: "new", label: "New run", key: "n" },
  { id: "ask", label: "Ask about the code (new conversation)", key: "?" },
  { id: "reply", label: "Follow-up in the selected conversation", key: "r" },
  { id: "up", label: "Start the run's applications", key: "u" },
  { id: "down", label: "Stop the run's applications", key: "w" },
  { id: "editor", label: "Open the worktree in your editor", key: "e" },
  { id: "shell", label: "Shell in the worktree", key: "t" },
  { id: "diff", label: "Diff of the run", key: "d" },
  { id: "next-waiting", label: "Go to the next session that needs you", key: "g" },
  { id: "settings", label: "Settings: editor, AI hosts", key: "," },
  { id: "quit", label: "Quit", key: "q" },
];

export function App(props: AppProps) {
  const { service } = props;
  const { exit } = useApp();
  // A TTY stream has a size; Ink's type is the general stream.
  const stdout = useStdout().stdout as unknown as NodeJS.WriteStream;
  const [size, setSize] = useState({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | undefined>(props.kept?.selected);
  const [tab, setTab] = useState<Tab>(props.kept?.tab ?? "overview");
  const [activity, setActivity] = useState<readonly RunActivity[]>([]);
  const [chat, setChat] = useState<Conversation | null>(null);
  const [pending, setPending] = useState<{ question: string; text: string } | undefined>();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const visited = useRef<string[]>([...(props.kept?.visited ?? [])]);
  const waitingBefore = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const s = await service.snapshot();
    setSnapshot(s);
    const waiting = totals(s).you;
    if (waitingBefore.current !== null && waiting > waitingBefore.current) props.bell?.();
    waitingBefore.current = waiting;
  }, [service, props.bell]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), props.refreshMs ?? 1000);
    return () => clearInterval(t);
  }, [refresh, props.refreshMs]);

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const rows = useMemo(() => (snapshot ? rowsOf(snapshot) : []), [snapshot]);
  const choices = useMemo(() => selectable(rows), [rows]);
  // The selection follows its session across refreshes; the first one when it is gone.
  const current = choices.find((r) => r.key === selected) ?? choices[0];
  useEffect(() => {
    if (current && current.key !== selected) setSelected(current.key);
  }, [current, selected]);

  const run = current?.kind === "run" ? current : undefined;
  const talk = current?.kind === "chat" ? current : undefined;
  useEffect(() => {
    if (!run) return;
    if (!visited.current.includes(run.run.runId)) visited.current.push(run.run.runId);
    void service.activity(run.repo, run.run.runId).then(setActivity);
  }, [run?.key, run?.run.updatedAt, run?.repo, run?.run.runId, service, run]);
  useEffect(() => {
    if (!talk) return setChat(null);
    void service.conversation(talk.repo, talk.chat.id).then(setChat);
  }, [talk?.key, talk?.chat.updatedAt, talk?.repo, talk?.chat.id, service, talk]);

  const say = (text: string | null, ok = "Done.") =>
    setNotice(text === null ? { text: ok, error: false } : { text, error: true });

  const quit = () => {
    props.onExit({ kind: "quit", visited: visited.current });
    exit();
  };

  const giveTerminal = (launch: Launch) => {
    props.onExit({
      kind: "launch",
      launch,
      state: { ...(selected ? { selected } : {}), tab, visited: visited.current },
    });
    exit();
  };

  const open = async (kind: "editor" | "shell" | "diff") => {
    const repo = run?.repo ?? snapshot?.repos[0]?.root;
    if (!repo) return;
    const r = await service.open(kind, repo, run?.run.runId);
    if (r && typeof r === "object") giveTerminal(r);
    else say(r, kind === "editor" ? "Opened in your editor." : "Done.");
  };

  const act = async (id: string) => {
    setDialog(null);
    const repoOf = run?.repo ?? snapshot?.folderRoot ?? snapshot?.repos[0]?.root ?? "";
    switch (id) {
      case "answer": {
        const q = run?.run.questions[0];
        if (run && q) setDialog({ kind: "answer", repo: run.repo, question: q });
        else if (run?.run.stages.some((s) => s.state === "waiting" && s.hitl))
          setDialog({ kind: "gate", repo: run.repo, run: run.run });
        else say("Nothing to answer here.");
        return;
      }
      case "continue":
        if (run) say(await service.continueRun(run.repo, run.run.runId), "The run is driven again.");
        return;
      case "stop":
        if (run) say(await service.stopRun(run.repo, run.run.runId), "Stopped; continue it any time.");
        return;
      case "new":
        setDialog({ kind: "new" });
        return;
      case "ask":
        setDialog({ kind: "ask", repo: snapshot?.folderRoot ?? snapshot?.repos[0]?.root ?? "" });
        return;
      case "reply":
        if (talk) setDialog({ kind: "ask", repo: talk.repo, conversation: talk.chat.id });
        else say("Select a conversation to follow up.");
        return;
      case "up":
      case "down":
        if (run?.run.worktree) {
          say("…", "");
          say(
            await service.apps(run.repo, run.run.worktree.id, id),
            id === "up" ? "Applications started." : "Applications stopped.",
          );
          void refresh();
        } else say("This run has no worktree of its own.");
        return;
      case "editor":
      case "shell":
      case "diff":
        await open(id);
        return;
      case "next-waiting": {
        const next = choices.find((r) => r.kind === "run" && r.run.attention === "you");
        if (next) setSelected(next.key);
        else say("Nothing waits for you.", "");
        return;
      }
      case "settings":
        setDialog({ kind: "settings", repo: repoOf, settings: await service.settings(repoOf) });
        return;
      case "quit":
        quit();
        return;
    }
  };

  const move = (by: number) => {
    if (choices.length === 0) return;
    const at = Math.max(
      0,
      choices.findIndex((r) => r.key === current?.key),
    );
    const next = choices[(at + by + choices.length) % choices.length] as Row & { key: string };
    setSelected(next.key);
    setNotice(null);
  };

  useInput(
    (input, key) => {
      if (key.escape) return setDialog(null);
      if (dialog) return;
      if (key.upArrow || input === "k") return move(-1);
      if (key.downArrow || input === "j") return move(1);
      if (key.tab || key.rightArrow) return setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length] as Tab);
      if (key.leftArrow) return setTab(TABS[(TABS.indexOf(tab) + TABS.length - 1) % TABS.length] as Tab);
      if (input === ":" || (key.ctrl && input === "k")) return setDialog({ kind: "palette" });
      if (key.return) {
        if (run?.run.attention === "you") return void act("answer");
        if (run && run.run.attention !== "driving" && run.run.status === "active")
          return void act("continue");
        if (talk) return void act("reply");
        return;
      }
      const byKey = COMMANDS.find((c) => c.key === input);
      if (byKey) void act(byKey.id);
    },
    { isActive: true },
  );

  const cols = size.columns;
  const height = Math.max(10, size.rows - 4);
  const left = Math.min(44, Math.max(28, Math.floor(cols * 0.34)));
  const right = Math.max(30, cols - left - 1);
  const t = snapshot ? totals(snapshot) : null;
  const repoName = (root: string) => snapshot?.repos.find((r) => r.root === root)?.name;

  return (
    <Box flexDirection="column" width={cols}>
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold color="cyan">
          MetatorAI · {snapshot?.title ?? "…"}
        </Text>
        {t ? (
          <Text>
            <Text color={t.you > 0 ? "yellow" : "gray"}>{t.you} need you</Text>
            <Text dimColor> · </Text>
            <Text color="cyan">{t.driving} driving</Text>
            <Text dimColor> · </Text>
            <Text>{t.stopped} stopped</Text>
            <Text dimColor> · </Text>
            <Text color="green">{t.services} services</Text>
          </Text>
        ) : null}
      </Box>
      <Box>
        <SessionList rows={rows} selected={current?.key} width={left} height={height - 3} />
        <Box flexDirection="column" width={right}>
          {dialog?.kind === "answer" ? (
            <AnswerDialog
              question={dialog.question}
              onAnswer={(choices, text) =>
                void service.answer(dialog.repo, dialog.question, choices, text).then((r) => {
                  setDialog(null);
                  say(r, `Answered ${dialog.question.id}: ${choices.join(", ")}`);
                  void refresh();
                })
              }
            />
          ) : dialog?.kind === "gate" ? (
            <GateDialog
              stage={dialog.run.stage}
              task={dialog.run.task}
              onDecide={(approve, reason) =>
                void service
                  .decideGate(dialog.repo, dialog.run.runId, dialog.run.stage, approve, reason)
                  .then((r) => {
                    setDialog(null);
                    say(r, approve ? `Approved ${dialog.run.stage}.` : `Rejected ${dialog.run.stage}.`);
                    void refresh();
                  })
              }
            />
          ) : dialog?.kind === "new" ? (
            <NewRunDialog
              repos={snapshot?.repos.map((r) => ({ name: r.name, root: r.root })) ?? []}
              options={(repo) => service.runOptions(repo)}
              onCreate={(repo, input) =>
                void service.newRun(repo, input).then((r) => {
                  setDialog(null);
                  if (r.runId) setSelected(`${repo}#${r.runId}`);
                  say(r.error ?? null, `Started ${r.runId}.`);
                  void refresh();
                })
              }
            />
          ) : dialog?.kind === "ask" ? (
            <AskDialog
              {...(dialog.conversation ? { followUp: dialog.conversation } : {})}
              onAsk={(question) => {
                const d = dialog;
                setDialog(null);
                setPending({ question, text: "" });
                void service
                  .ask(d.repo, question, d.conversation, (line) =>
                    setPending((p) => (p ? { ...p, text: p.text ? `${p.text}\n${line}` : line } : p)),
                  )
                  .then(async (r) => {
                    setPending(undefined);
                    await refresh();
                    if (r.conversation) setSelected(`${d.repo}~${r.conversation}`);
                    say(r.error ?? null, "Answered.");
                  });
              }}
            />
          ) : dialog?.kind === "settings" ? (
            <SettingsDialog
              settings={dialog.settings}
              onSave={(changes: { editor?: string; hostTargets?: readonly HostTarget[] }) =>
                void service.saveSettings(dialog.repo, changes).then((r) => {
                  setDialog(null);
                  say(
                    r,
                    changes.hostTargets
                      ? "Saved. Run `metator agents update` to install the agents for these hosts."
                      : "Saved.",
                  );
                })
              }
            />
          ) : dialog?.kind === "palette" ? (
            <Palette commands={COMMANDS} onRun={(id) => void act(id)} />
          ) : null}
          {dialog ? null : pending ? (
            <ChatView conversation={null} pending={pending} width={right} height={height - 3} />
          ) : run ? (
            <RunDetail
              run={run.run as RunOverview}
              {...(snapshot && snapshot.repos.length > 1 ? { repoName: repoName(run.repo) ?? "" } : {})}
              tab={tab}
              activity={activity}
              width={right}
              height={height - 3}
            />
          ) : talk ? (
            <ChatView conversation={chat} width={right} height={height - 3} />
          ) : (
            <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column" width={right}>
              <Text>Nothing selected.</Text>
              <Text dimColor>n: start a run · ?: ask a question about the code · :: all commands</Text>
            </Box>
          )}
        </Box>
      </Box>
      <Box paddingX={1}>
        {notice ? (
          <Text color={notice.error ? "red" : "green"}>{notice.text}</Text>
        ) : (
          <Text dimColor>
            ↑↓ select · ⏎ act · tab view · a answer · n new run · ? ask · c continue · : all commands · ,
            settings · q quit
          </Text>
        )}
      </Box>
    </Box>
  );
}
