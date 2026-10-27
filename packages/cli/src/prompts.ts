import { cancel, confirm, intro, isCancel, multiselect, outro } from "@clack/prompts";
import type { HostTarget } from "@metator/core";

export interface SetupAnswers {
  readonly hosts: readonly HostTarget[];
  readonly workflows: readonly string[];
  readonly hooks: boolean;
}

export interface SetupQuestions {
  readonly available: readonly string[];
  readonly defaults: SetupAnswers;
}

/** Asks the setup questions; null when the person cancelled. */
export type SetupPrompter = (questions: SetupQuestions) => Promise<SetupAnswers | null>;

const HOST_LABELS: Record<HostTarget, string> = { claude: "Claude Code", copilot: "GitHub Copilot" };

/**
 * The terminal wizard of `metator setup` (@clack/prompts). Questions go to stderr, so stdout
 * keeps the one JSON envelope every command prints.
 */
export const terminalPrompter: SetupPrompter = async ({ available, defaults }) => {
  const io = { output: process.stderr };
  intro("MetatorAI setup", io);
  const hosts = await multiselect<HostTarget>({
    ...io,
    message: "Which AI hosts should get the agents, skills and hooks?",
    options: (Object.keys(HOST_LABELS) as HostTarget[]).map((h) => ({ value: h, label: HOST_LABELS[h] })),
    initialValues: [...defaults.hosts],
    required: true,
  });
  if (isCancel(hosts)) return cancelled();
  const workflows = await multiselect<string>({
    ...io,
    message: "Which workflows should this repository run?",
    options: available.map((w) => ({ value: w, label: w })),
    initialValues: [...defaults.workflows],
    required: true,
  });
  if (isCancel(workflows)) return cancelled();
  const hooks = await confirm({
    ...io,
    message: "Install the hooks (`metator guard`) that enforce scope and approvals?",
    initialValue: defaults.hooks,
  });
  if (isCancel(hooks)) return cancelled();
  outro("Installing…", io);
  return { hosts, workflows, hooks };
};

function cancelled(): null {
  cancel("Setup cancelled; nothing was written.", { output: process.stderr });
  return null;
}
