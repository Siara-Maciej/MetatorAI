import { cancel, confirm, intro, isCancel, log, multiselect, outro, select, text } from "@clack/prompts";
import { type Autonomy, type HostTarget, needsWords, type Question, wordsRequired } from "@metator/core";

export interface SetupAnswers {
  readonly hosts: readonly HostTarget[];
  readonly hooks: boolean;
}

export interface SetupQuestions {
  /** Ask which hosts: nothing in the repository or on the machine says, or they point two ways. */
  readonly askHosts: boolean;
  /** The hosts found (preselected when asked, said when not) and whether `--hooks` was given. */
  readonly defaults: SetupAnswers;
}

export interface NewRunQuestions {
  /** The workflows installed here; `autonomy` lists the levels each one supports (all, when it does not say). */
  readonly workflows: readonly {
    readonly id: string;
    readonly description?: string;
    readonly autonomy?: readonly Autonomy[];
  }[];
  /** The AI hosts that can run agents on this machine. */
  readonly hosts: readonly string[];
  readonly defaultHost: string;
}

/** The workflow a new run starts with unless the person picks another: a feature, else the first. */
export const FIRST_WORKFLOW = "mt-feature";
export function firstWorkflow(workflows: readonly { readonly id: string }[]): string | undefined {
  return (workflows.find((w) => w.id === FIRST_WORKFLOW) ?? workflows[0])?.id;
}

const AUTONOMY_HINTS: Record<Autonomy, string> = {
  L0: "every approval waits for you",
  L1: "the approvals the workflow lets this level skip are skipped",
  L2: "no person at the terminal: only the approvals that are never skipped wait for you",
};

/** The autonomy levels a workflow can run at, each with what it means; all three when it does not say. */
export function autonomyChoices(levels: readonly Autonomy[] | undefined): readonly Choice<Autonomy>[] {
  return (["L0", "L1", "L2"] as const)
    .filter((level) => !levels || levels.includes(level))
    .map((level) => ({ value: level, label: level, hint: AUTONOMY_HINTS[level] }));
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
  /** One choice from a list (a yes or no before something is done). */
  choose<T extends string>(message: string, options: readonly Choice<T>[]): Promise<T | null>;
  show(line: string): void;
  /** Gets the person's attention (terminal bell): a question is waiting. */
  bell(): void;
  /** Writes text as is: what a command renders for a person (`render`). */
  raw(text: string): void;
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
  async setup({ askHosts, defaults }) {
    intro("MetatorAI setup", io);
    let hosts: readonly HostTarget[] = defaults.hosts;
    if (askHosts) {
      const chosen = await multiselect<HostTarget>({
        ...io,
        message: "Which AI hosts should get the agents, skills and hooks?",
        options: (["claude", "copilot"] as HostTarget[]).map((h) => ({
          value: h,
          label: HOST_LABELS[h] as string,
        })),
        initialValues: [...defaults.hosts],
        required: true,
      });
      if (isCancel(chosen)) return cancelled("Setup cancelled; nothing was written.");
      hosts = chosen;
    } else log.info(`AI hosts: ${hosts.map((h) => HOST_LABELS[h]).join(", ")} (--host changes it)`, io);
    let hooks = defaults.hooks;
    if (!hooks) {
      const wanted = await confirm({
        ...io,
        message: "Install the hooks (`metator guard`) that enforce scope and approvals?",
        initialValue: false,
      });
      if (isCancel(wanted)) return cancelled("Setup cancelled; nothing was written.");
      hooks = wanted;
    }
    outro("Installing…", io);
    return { hosts, hooks };
  },

  async newRun({ workflows, hosts, defaultHost }) {
    intro("New MetatorAI run", io);
    // A question with one answer is not asked: the answer is said instead.
    const first = firstWorkflow(workflows);
    if (first === undefined) return cancelled("No run started.");
    const workflow =
      workflows.length > 1
        ? await select<string>({
            ...io,
            message: "Which workflow?",
            options: workflows.map((w) => ({
              value: w.id,
              label: w.id,
              ...(w.description ? { hint: w.description } : {}),
            })),
            initialValue: first,
          })
        : first;
    if (isCancel(workflow)) return cancelled("No run started.");
    if (workflows.length === 1) log.info(`Workflow: ${workflow}`, io);
    const task = await text({
      ...io,
      message: "What is the task? (issue text or a work item reference)",
      validate: (v) => (v?.trim() ? undefined : "The task must not be empty"),
    });
    if (isCancel(task)) return cancelled("No run started.");
    const levels = autonomyChoices(workflows.find((w) => w.id === workflow)?.autonomy);
    const only = levels[0] ?? { value: "L0" as const, label: "L0" };
    const autonomy =
      levels.length > 1
        ? await select<Autonomy>({
            ...io,
            message: "Autonomy: how many approvals wait for you?",
            options: levels.map((l) => ({
              value: l.value,
              label: l.label,
              ...(l.hint ? { hint: l.hint } : {}),
            })),
          })
        : only.value;
    if (isCancel(autonomy)) return cancelled("No run started.");
    if (levels.length <= 1) log.info(`Autonomy: ${autonomy} (the only level ${workflow} runs at)`, io);
    const preferred = hosts.includes(defaultHost) ? defaultHost : (hosts[0] ?? defaultHost);
    const host =
      hosts.length > 1
        ? await select<string>({
            ...io,
            message: "Which AI host runs the agents?",
            options: hosts.map((h) => ({ value: h, label: HOST_LABELS[h] ?? h })),
            initialValue: preferred,
          })
        : preferred;
    if (isCancel(host)) return cancelled("No run started.");
    if (hosts.length <= 1)
      log.info(`AI host: ${HOST_LABELS[host] ?? host} (the only one installed here)`, io);
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
    // Only Other and Reject promise the person's own words; Deny is a whole answer.
    if (!needsWords(choices)) return { choices };
    const words = await text({
      ...io,
      message: wordsRequired(choices) ? "Your answer" : "Why? (it goes back to the run)",
      validate: (v) => (wordsRequired(choices) && !v?.trim() ? "Write your answer" : undefined),
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

  raw(text) {
    process.stderr.write(text);
  },
};

function cancelled(message: string): null {
  cancel(message, io);
  return null;
}
