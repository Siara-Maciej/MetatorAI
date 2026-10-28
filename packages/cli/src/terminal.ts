import { cancel, confirm, intro, isCancel, log, multiselect, outro, select, text } from "@clack/prompts";
import type { Autonomy, HostTarget, Question } from "@metator/core";

export interface SetupAnswers {
  readonly hosts: readonly HostTarget[];
  readonly workflows: readonly string[];
  readonly hooks: boolean;
}

export interface SetupQuestions {
  readonly available: readonly string[];
  readonly defaults: SetupAnswers;
}

export interface NewRunQuestions {
  readonly workflows: readonly { readonly id: string; readonly description?: string }[];
  readonly hosts: readonly string[];
  readonly defaultHost: string;
}

export interface NewRunAnswers {
  readonly workflow: string;
  readonly task: string;
  readonly autonomy: Autonomy;
  readonly host: string;
  readonly worktree: boolean;
}

export interface RunChoice {
  readonly runId: string;
  readonly label: string;
  readonly hint: string;
}

export interface PersonAnswer {
  readonly choices: readonly string[];
  readonly text?: string;
}

/**
 * The person at the terminal (ADR-0052). Everything goes to stderr, so stdout keeps the one JSON
 * envelope every command prints; null always means the person cancelled (Ctrl+C).
 */
export interface Terminal {
  setup(q: SetupQuestions): Promise<SetupAnswers | null>;
  newRun(q: NewRunQuestions): Promise<NewRunAnswers | null>;
  pickRun(runs: readonly RunChoice[]): Promise<string | null>;
  answer(q: Question): Promise<PersonAnswer | null>;
  /** One choice from a list (`metator ui` menus). */
  choose<T extends string>(message: string, options: readonly Choice<T>[]): Promise<T | null>;
  show(line: string): void;
  /** Gets the person's attention (terminal bell): a question is waiting. */
  bell(): void;
}

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

const io = { output: process.stderr };
const HOST_LABELS: Record<string, string> = {
  claude: "Claude Code",
  copilot: "GitHub Copilot",
  scenario: "Scenario (no model)",
};

/** The terminal on @clack/prompts. */
export const clackTerminal: Terminal = {
  async setup({ available, defaults }) {
    intro("MetatorAI setup", io);
    const hosts = await multiselect<HostTarget>({
      ...io,
      message: "Which AI hosts should get the agents, skills and hooks?",
      options: (["claude", "copilot"] as HostTarget[]).map((h) => ({
        value: h,
        label: HOST_LABELS[h] as string,
      })),
      initialValues: [...defaults.hosts],
      required: true,
    });
    if (isCancel(hosts)) return cancelled("Setup cancelled; nothing was written.");
    const workflows = await multiselect<string>({
      ...io,
      message: "Which workflows should this repository run?",
      options: available.map((w) => ({ value: w, label: w })),
      initialValues: [...defaults.workflows],
      required: true,
    });
    if (isCancel(workflows)) return cancelled("Setup cancelled; nothing was written.");
    const hooks = await confirm({
      ...io,
      message: "Install the hooks (`metator guard`) that enforce scope and approvals?",
      initialValue: defaults.hooks,
    });
    if (isCancel(hooks)) return cancelled("Setup cancelled; nothing was written.");
    outro("Installing…", io);
    return { hosts, workflows, hooks };
  },

  async newRun({ workflows, hosts, defaultHost }) {
    intro("New MetatorAI run", io);
    const workflow = await select<string>({
      ...io,
      message: "Which workflow?",
      options: workflows.map((w) => ({
        value: w.id,
        label: w.id,
        ...(w.description ? { hint: w.description } : {}),
      })),
    });
    if (isCancel(workflow)) return cancelled("No run started.");
    const task = await text({
      ...io,
      message: "What is the task? (issue text or a work item reference)",
      validate: (v) => (v?.trim() ? undefined : "The task must not be empty"),
    });
    if (isCancel(task)) return cancelled("No run started.");
    const autonomy = await select<Autonomy>({
      ...io,
      message: "Autonomy",
      options: [
        { value: "L0", label: "L0", hint: "you approve every gate" },
        { value: "L1", label: "L1", hint: "the plan approval is skipped" },
        { value: "L2", label: "L2", hint: "headless: only gates that never skip ask you" },
      ],
    });
    if (isCancel(autonomy)) return cancelled("No run started.");
    const host = await select<string>({
      ...io,
      message: "Which AI host runs the agents?",
      options: hosts.map((h) => ({ value: h, label: HOST_LABELS[h] ?? h })),
      initialValue: defaultHost,
    });
    if (isCancel(host)) return cancelled("No run started.");
    const worktree = await confirm({
      ...io,
      message: "Work in its own git worktree (your working tree stays untouched)?",
      initialValue: true,
    });
    if (isCancel(worktree)) return cancelled("No run started.");
    return { workflow, task: task.trim(), autonomy, host, worktree };
  },

  async pickRun(runs) {
    const runId = await select<string>({
      ...io,
      message: "Which run?",
      options: runs.map((r) => ({ value: r.runId, label: r.label, hint: r.hint })),
    });
    return isCancel(runId) ? cancelled("Nothing continued.") : runId;
  },

  async answer(q) {
    const header = `${q.stage}${q.agent ? ` · ${q.agent}` : ""} · ${q.source}`;
    const chosen = q.multiSelect
      ? await multiselect<string>({
          ...io,
          message: `${header}\n${q.prompt}`,
          options: q.options.map((o) => ({
            value: o.label,
            label: o.label,
            ...(o.description ? { hint: o.description } : {}),
          })),
          required: true,
        })
      : await select<string>({
          ...io,
          message: `${header}\n${q.prompt}`,
          options: q.options.map((o) => ({
            value: o.label,
            label: o.label,
            ...(o.description ? { hint: o.description } : {}),
          })),
        });
    if (isCancel(chosen)) return null;
    const choices = Array.isArray(chosen) ? chosen : [chosen];
    const needsText = choices.includes("Other") || choices.includes("Reject") || choices.includes("Deny");
    if (!needsText) return { choices };
    const words = await text({
      ...io,
      message: choices.includes("Other") ? "Your answer" : "Why? (it goes back to the run)",
      validate: (v) => (choices.includes("Other") && !v?.trim() ? "Write your answer" : undefined),
    });
    if (isCancel(words)) return null;
    return { choices, ...(words.trim() ? { text: words.trim() } : {}) };
  },

  async choose<T extends string>(message: string, options: readonly Choice<T>[]): Promise<T | null> {
    const picked = await select<string>({
      ...io,
      message,
      options: options.map((o) => ({
        value: o.value as string,
        label: o.label,
        ...(o.hint ? { hint: o.hint } : {}),
      })),
    });
    return isCancel(picked) ? null : (picked as T);
  },

  show(line) {
    log.message(line, { ...io, symbol: "│" });
  },

  bell() {
    process.stderr.write("\x07");
  },
};

function cancelled(message: string): null {
  cancel(message, io);
  return null;
}
