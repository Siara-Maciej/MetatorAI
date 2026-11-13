import { MultiSelect, Select, TextInput } from "@inkjs/ui";
import { type Autonomy, type HostTarget, needsWords, type Question } from "@metator/core";
import { Box, Text } from "ink";
import { useState } from "react";
import type { NewRunInput, RunOptions, Settings } from "../service.ts";

function Frame(props: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly hint?: string;
}) {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {props.title}
      </Text>
      {props.children}
      <Text dimColor>{props.hint ?? "esc: back"}</Text>
    </Box>
  );
}

/** A question of a run: pick an option; Other and Reject ask for words too (`needsWords`). */
export function AnswerDialog(props: {
  readonly question: Question;
  readonly onAnswer: (choices: string[], text?: string) => void;
}) {
  const q = props.question;
  const [choice, setChoice] = useState<string | null>(null);
  const header = `${q.stage}${q.agent ? ` · ${q.agent}` : ""} · ${q.source}`;
  if (choice && needsWords([choice]))
    return (
      <Frame title={`${header} · ${choice}`}>
        <Text>{choice === "Other" ? "Your answer:" : "Why? (it goes back to the run)"}</Text>
        <TextInput placeholder="…" onSubmit={(text) => props.onAnswer([choice], text.trim() || undefined)} />
      </Frame>
    );
  const card = q.card;
  const label = (o: Question["options"][number]) =>
    `${o.label}${o.label === card?.recommended ? " (recommended)" : ""}${o.description ? ` — ${o.description}` : ""}`;
  return (
    <Frame title={header}>
      {card ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text wrap="truncate-end">
            <Text dimColor>task </Text>
            {card.task}
          </Text>
          {card.done.length > 0 ? <Text dimColor>done: {card.done.join(" → ")}</Text> : null}
          {card.artifacts.length > 0 ? <Text dimColor>artifacts: {card.artifacts.join(", ")}</Text> : null}
          {card.reversible ? null : <Text color="yellow">cannot be taken back once answered</Text>}
        </Box>
      ) : null}
      <Text wrap="wrap">{q.prompt}</Text>
      {q.multiSelect ? (
        <MultiSelect
          options={q.options.map((o) => ({ label: label(o), value: o.label }))}
          onSubmit={(values) => props.onAnswer(values)}
        />
      ) : (
        <Select
          options={q.options.map((o) => ({ label: label(o), value: o.label }))}
          onChange={(v) => (needsWords([v]) ? setChoice(v) : props.onAnswer([v]))}
        />
      )}
    </Frame>
  );
}

/** A human gate with nobody driving: approve it, or reject it with words for the run. */
export function GateDialog(props: {
  readonly stage: string;
  readonly task: string;
  readonly onDecide: (approve: boolean, reason?: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  if (rejecting)
    return (
      <Frame title={`${props.stage} · Reject`}>
        <Text>Why? (it goes back to the run)</Text>
        <TextInput placeholder="…" onSubmit={(t) => props.onDecide(false, t.trim() || undefined)} />
      </Frame>
    );
  return (
    <Frame title={`${props.stage} · gate`}>
      <Text wrap="wrap">{props.task}: approve to continue?</Text>
      <Select
        options={[
          { label: "Approve", value: "approve" },
          { label: "Reject", value: "reject" },
        ]}
        onChange={(v) => (v === "approve" ? props.onDecide(true) : setRejecting(true))}
      />
    </Frame>
  );
}

/** The new-run form, one question at a time. */
export function NewRunDialog(props: {
  readonly repos: readonly { readonly name: string; readonly root: string }[];
  readonly options: (repo: string) => Promise<RunOptions>;
  readonly onCreate: (repo: string, input: NewRunInput) => void;
}) {
  const [repo, setRepo] = useState<string | null>(
    props.repos.length === 1 ? (props.repos[0]?.root ?? null) : null,
  );
  const [opts, setOpts] = useState<RunOptions | null>(null);
  const [workflow, setWorkflow] = useState<string | null>(null);
  const [task, setTask] = useState<string | null>(null);
  const [autonomy, setAutonomy] = useState<Autonomy | null>(null);
  const [host, setHost] = useState<string | null>(null);
  if (!repo)
    return (
      <Frame title="New run · which repository?">
        <Select options={props.repos.map((r) => ({ label: r.name, value: r.root }))} onChange={setRepo} />
      </Frame>
    );
  if (!opts) {
    void props.options(repo).then(setOpts);
    return (
      <Frame title="New run">
        <Text dimColor>Reading the workflows…</Text>
      </Frame>
    );
  }
  if (opts.workflows.length === 0)
    return (
      <Frame title="New run">
        <Text color="yellow">No workflows here: run `metator setup` in this repository.</Text>
      </Frame>
    );
  if (!workflow)
    return (
      <Frame title="New run · which workflow?">
        <Select
          options={opts.workflows.map((w) => ({
            label: w.description ? `${w.id} — ${w.description}` : w.id,
            value: w.id,
          }))}
          onChange={setWorkflow}
        />
      </Frame>
    );
  if (task === null)
    return (
      <Frame title={`New run · ${workflow} · what is the task?`}>
        <TextInput
          placeholder="Issue text or a work item reference"
          onSubmit={(t) => t.trim() && setTask(t.trim())}
        />
      </Frame>
    );
  if (!autonomy)
    return (
      <Frame title="New run · autonomy">
        <Select
          options={[
            { label: "L0 — you approve every gate", value: "L0" },
            { label: "L1 — the plan approval is skipped", value: "L1" },
            { label: "L2 — headless: only gates that never skip ask you", value: "L2" },
          ]}
          onChange={(v) => setAutonomy(v as Autonomy)}
        />
      </Frame>
    );
  if (!host)
    return (
      <Frame title="New run · which AI host runs the agents?">
        <Select
          options={opts.hosts.map((h) => ({ label: h, value: h }))}
          defaultValue={opts.defaultHost}
          onChange={setHost}
        />
      </Frame>
    );
  return (
    <Frame title="New run · its own git worktree?">
      <Text dimColor>Your working tree stays untouched; the run gets its own ports.</Text>
      <Select
        options={[
          { label: "Yes, in its own worktree", value: "yes" },
          { label: "No, in this checkout", value: "no" },
        ]}
        onChange={(v) => props.onCreate(repo, { workflow, task, autonomy, host, worktree: v === "yes" })}
      />
    </Frame>
  );
}

/** One line of text: a question for mt-guide, or a follow-up. */
export function AskDialog(props: { readonly followUp?: string; readonly onAsk: (question: string) => void }) {
  return (
    <Frame
      title={props.followUp ? `Follow-up · ${props.followUp}` : "Ask about the code"}
      hint="enter: ask · esc: back"
    >
      <Text dimColor>mt-guide reads the code (never changes it) and cites path:line.</Text>
      <TextInput
        placeholder="How is the discount computed?"
        onSubmit={(q) => q.trim() && props.onAsk(q.trim())}
      />
    </Frame>
  );
}

type SettingsStep = "menu" | "editor" | "editor-command" | "hosts";

/** Settings saved in metator.config.yml: the editor, the AI hosts. */
export function SettingsDialog(props: {
  readonly settings: Settings;
  readonly onSave: (changes: { editor?: string; hostTargets?: readonly HostTarget[] }) => void;
}) {
  const s = props.settings;
  const [step, setStep] = useState<SettingsStep>("menu");
  if (step === "editor")
    return (
      <Frame title="Settings · editor">
        <Select
          options={[
            ...s.editors.map((e) => ({ label: `${e.label} (${e.command})`, value: e.command })),
            { label: "Type a command…", value: "__type" },
          ]}
          onChange={(v) => (v === "__type" ? setStep("editor-command") : props.onSave({ editor: v }))}
        />
      </Frame>
    );
  if (step === "editor-command")
    return (
      <Frame title="Settings · editor command">
        <TextInput
          placeholder="code --new-window"
          onSubmit={(v) => v.trim() && props.onSave({ editor: v.trim() })}
        />
      </Frame>
    );
  if (step === "hosts")
    return (
      <Frame title="Settings · AI hosts that get the agents" hint="space: toggle · enter: save · esc: back">
        <MultiSelect
          options={s.allHosts.map((h) => ({
            label: h === "claude" ? "Claude Code" : "GitHub Copilot",
            value: h,
          }))}
          defaultValue={[...s.hostTargets]}
          onSubmit={(v) => v.length > 0 && props.onSave({ hostTargets: v as HostTarget[] })}
        />
      </Frame>
    );
  return (
    <Frame title={`Settings · ${s.file ?? "metator.config.yml (new)"}`}>
      <Select
        options={[
          { label: `Editor: ${s.editor ?? "not set ($VISUAL, $EDITOR)"}`, value: "editor" },
          { label: `AI hosts: ${s.hostTargets.join(", ")}`, value: "hosts" },
        ]}
        onChange={(v) => setStep(v as SettingsStep)}
      />
    </Frame>
  );
}

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly key?: string;
}

/** Every action by name: type to filter, enter to run it. */
export function Palette(props: {
  readonly commands: readonly PaletteCommand[];
  readonly onRun: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = props.commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
  return (
    <Frame title="Commands" hint="type to filter · ↑↓ enter: run · esc: back">
      <TextInput placeholder="filter…" onChange={setFilter} />
      {shown.length === 0 ? (
        <Text dimColor>No command matches.</Text>
      ) : (
        <Select
          key={filter}
          visibleOptionCount={10}
          options={shown.map((c) => ({ label: c.key ? `${c.label}  (${c.key})` : c.label, value: c.id }))}
          onChange={props.onRun}
        />
      )}
    </Frame>
  );
}
