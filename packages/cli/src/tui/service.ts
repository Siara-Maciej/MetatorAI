import { basename } from "node:path";
import {
  type Autonomy,
  type Conversation,
  editorLaunch,
  HOST_TARGETS,
  type HostTarget,
  KNOWN_EDITORS,
  preferredEditor,
  type Question,
  type RunActivity,
} from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { askPlace, folderPlace } from "../ask-place.ts";
import type { Folder } from "../context.ts";
import { person } from "../live.ts";
import { defaultHost, startDetached } from "../sessions.ts";
import type { RepoWork, Snapshot } from "./model.ts";

/** A program that needs the whole terminal (a terminal editor, a shell, `git diff`). */
export interface Launch {
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface RunOptions {
  readonly workflows: readonly { readonly id: string; readonly description?: string }[];
  readonly hosts: readonly string[];
  readonly defaultHost: string;
}

export interface NewRunInput {
  readonly workflow: string;
  readonly task: string;
  readonly autonomy: Autonomy;
  readonly host: string;
  readonly worktree: boolean;
}

export interface Settings {
  readonly editor?: string;
  /** Editors found on PATH, to pick one from. */
  readonly editors: readonly { readonly command: string; readonly label: string }[];
  readonly hostTargets: readonly HostTarget[];
  readonly allHosts: readonly HostTarget[];
  /** The config file the settings are read from and saved to (null: none yet). */
  readonly file: string | null;
}

/** An error message for the person, or null when it worked. */
export type Outcome = string | null;

/**
 * Everything `metator ui` can do (G5, ADR-0060), on the repositories' own containers. The view
 * only calls this; tests give it a fake.
 */
export interface TuiService {
  snapshot(): Promise<Snapshot>;
  activity(repo: string, runId: string): Promise<readonly RunActivity[]>;
  conversation(repo: string, id: string): Promise<Conversation | null>;
  answer(repo: string, q: Question, choices: readonly string[], text?: string): Promise<Outcome>;
  /** A human gate nobody drives yet: approve it, or reject it with a reason. */
  decideGate(repo: string, runId: string, stage: string, approve: boolean, reason?: string): Promise<Outcome>;
  continueRun(repo: string, runId: string): Promise<Outcome>;
  stopRun(repo: string, runId: string): Promise<Outcome>;
  runOptions(repo: string): Promise<RunOptions>;
  newRun(repo: string, input: NewRunInput): Promise<{ readonly runId?: string; readonly error?: string }>;
  ask(
    repo: string,
    question: string,
    conversation: string | undefined,
    onText: (text: string) => void,
  ): Promise<{ readonly conversation?: string; readonly error?: string }>;
  apps(repo: string, worktree: string, op: "up" | "down"): Promise<Outcome>;
  settings(repo: string): Promise<Settings>;
  saveSettings(
    repo: string,
    changes: { editor?: string; hostTargets?: readonly HostTarget[] },
  ): Promise<Outcome>;
  /** Opens the run's worktree (or the repository): a window editor opens at once; others need the terminal. */
  open(kind: "editor" | "shell" | "diff", repo: string, runId?: string): Promise<Launch | Outcome>;
  launch(l: Launch): Promise<Outcome>;
}

export interface ServiceContext {
  readonly containerAt: (root: string) => MetatorContainer;
  readonly folder: Folder | null;
  /** The repository `metator ui` runs in (outside a folder). */
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function tuiService(ctx: ServiceContext): TuiService {
  const cache = new Map<string, MetatorContainer>();
  const at = (root: string) => {
    const hit = cache.get(root);
    if (hit) return hit;
    const c = ctx.containerAt(root);
    cache.set(root, c);
    return c;
  };
  const repos = ctx.folder
    ? ctx.folder.repos.map((r) => ({ name: r.name, root: r.root }))
    : [{ name: basename(ctx.root), root: ctx.root }];
  const message = (e: { message: string; hint?: string | undefined }) =>
    e.hint ? `${e.message}. ${e.hint}` : e.message;
  const dirOf = async (repo: string, runId?: string) => {
    if (!runId) return repo;
    const r = await at(repo).resolve("runRepository").load(runId);
    return r.isOk() && r.value.worktree ? `${repo}/${r.value.worktree.path}` : repo;
  };

  return {
    async snapshot() {
      const work: RepoWork[] = [];
      for (const r of repos) {
        try {
          const o = await at(r.root).resolve("workOverview").execute();
          work.push(o.isOk() ? { ...r, overview: o.value } : { ...r, error: o.error.message });
        } catch (e) {
          work.push({ ...r, error: (e as Error).message });
        }
      }
      if (!ctx.folder) return { title: repos[0]?.name ?? "", repos: work };
      const talks = await at(ctx.folder.root).resolve("conversationRepository").list();
      return {
        title: `${basename(ctx.folder.root)} · ${repos.length} repositories`,
        repos: work,
        folderRoot: ctx.folder.root,
        folderConversations: talks.isOk()
          ? talks.value.map((c) => ({
              id: c.id,
              title: c.title,
              host: c.host,
              turns: c.turns.length,
              updatedAt: c.updatedAt,
            }))
          : [],
      };
    },

    async activity(repo, runId) {
      const r = await at(repo).resolve("runJournal").activity(runId);
      return r.isOk() ? r.value : [];
    },

    async conversation(repo, id) {
      const r = await at(repo).resolve("conversationRepository").load(id);
      return r.isOk() ? r.value : null;
    },

    async answer(repo, q, choices, text) {
      const r = await at(repo)
        .resolve("runJournal")
        .answer(q.runId, q.id, { choices: [...choices], ...(text ? { text } : {}), by: person(ctx.env) });
      if (r.isErr()) return message(r.error);
      // An answer is carried out by the drive: with none alive, the run is driven again.
      return this.continueRun(repo, q.runId);
    },

    async decideGate(repo, runId, stage, approve, reason) {
      const c = at(repo);
      const r = approve
        ? await c.resolve("approveRun").execute({ runId, gate: stage, by: person(ctx.env) })
        : await c
            .resolve("advanceRun")
            .execute({ runId, event: { type: "FAIL", ...(reason ? { reason } : {}) } });
      return r.isOk() ? null : message(r.error);
    },

    async continueRun(repo, runId) {
      const c = at(repo);
      const driver = await c.resolve("runDrivers").status(runId);
      if (driver.isOk() && driver.value?.alive) return null;
      const record = await c.resolve("runRepository").load(runId);
      if (record.isErr()) return message(record.error);
      // An escalated run goes back to the stage it escalated from (its cause is fixed), then on.
      if (record.value.state.status === "escalated") {
        const resumed = await c.resolve("resumeRun").execute({ runId, by: person(ctx.env) });
        if (resumed.isErr()) return message(resumed.error);
      }
      // The host that drove it last, else the one the run records, else the default.
      const last = driver.isOk() ? driver.value?.host : undefined;
      const hosts = c.resolve("agentHosts");
      const host =
        [last, record.value.host].find((h): h is string => !!h && hosts.has(h)) ?? defaultHost(c, ctx.env);
      const started = await startDetached(c, repo, runId, host);
      return started.isOk() ? null : message(started.error);
    },

    async stopRun(repo, runId) {
      const r = await at(repo).resolve("runDrivers").stop(runId);
      return r.isOk() ? null : message(r.error);
    },

    async runOptions(repo) {
      const c = at(repo);
      const scan = await c.resolve("workflowCatalog").scan();
      return {
        workflows: scan.workflows.map((w) => ({
          id: w.spec.id,
          ...(w.spec.description ? { description: w.spec.description } : {}),
        })),
        hosts: [...c.resolve("agentHosts").keys()],
        defaultHost: defaultHost(c, ctx.env),
      };
    },

    async newRun(repo, input) {
      const c = at(repo);
      const run = await c.resolve("initRun").execute({
        workflow: input.workflow,
        task: input.task,
        autonomy: input.autonomy,
        ...(input.worktree ? { worktree: {} } : {}),
      });
      if (run.isErr()) return { error: message(run.error) };
      const started = await startDetached(c, repo, run.value.runId, input.host);
      return started.isOk() ? { runId: run.value.runId } : { error: message(started.error) };
    },

    async ask(repo, question, conversation, onText) {
      const place =
        ctx.folder && repo === ctx.folder.root
          ? folderPlace(ctx.folder, at(repo))
          : askPlace({ container: () => at(repo), containerAt: at, folder: () => null });
      const r = await place.container.resolve("askQuestion").execute({
        question,
        ...(conversation ? { conversation } : {}),
        defaultHost: defaultHost(place.container, ctx.env),
        by: person(ctx.env),
        cwd: place.cwd,
        projectRoot: place.projectRoot,
        where: place.where,
        onEvent: (e) => {
          if (e.type === "text") onText(e.text);
        },
      });
      return r.isOk() ? { conversation: r.value.conversation.id } : { error: message(r.error) };
    },

    async apps(repo, worktree, op) {
      const s = at(repo).resolve("environmentServices");
      const r = op === "up" ? await s.up({ worktree }) : await s.down({ worktree });
      return r.isOk() ? null : message(r.error);
    },

    async settings(repo) {
      const c = at(repo);
      const config = c.resolve("config");
      const found = c.resolve("launcher").available(KNOWN_EDITORS.map((e) => e.command));
      return {
        ...(config.config.editor ? { editor: config.config.editor } : {}),
        editors: KNOWN_EDITORS.filter((e) => found.includes(e.command)).map((e) => ({
          command: e.command,
          label: e.label,
        })),
        hostTargets: [...config.config.hosts.targets],
        allHosts: [...HOST_TARGETS],
        file: config.source ?? null,
      };
    },

    async saveSettings(repo, changes) {
      const r = await at(repo).resolve("updateConfig").execute(changes);
      cache.delete(repo); // the next read sees the new config
      return r.isOk() ? null : message(r.error);
    },

    async open(kind, repo, runId) {
      const c = at(repo);
      const dir = await dirOf(repo, runId);
      if (kind === "shell") return { argv: [ctx.env.SHELL || "sh"], cwd: dir };
      if (kind === "diff") {
        let base = "HEAD";
        if (dir !== repo) {
          const runner = c.resolve("processRunner");
          const head = await runner.run({ argv: ["git", "rev-parse", "HEAD"], cwd: repo });
          const fork = await runner.run({
            argv: ["git", "merge-base", "HEAD", head.stdout.trim()],
            cwd: dir,
          });
          if (fork.exitCode === 0) base = fork.stdout.trim();
        }
        return { argv: ["git", "diff", base], cwd: dir };
      }
      const editor = preferredEditor(c.resolve("config").config.editor, ctx.env);
      if (!editor) return "No editor is set: choose one in the settings (,).";
      const l = editorLaunch(editor, dir);
      if (l.attached) return { argv: l.argv, cwd: dir };
      const r = await c.resolve("launcher").detached(l.argv, dir);
      return r.isOk() ? null : message(r.error);
    },

    async launch(l) {
      const c = at(repos[0]?.root ?? ctx.root);
      const r = await c.resolve("launcher").attached(l.argv, l.cwd);
      return r.isOk() ? null : message(r.error);
    },
  };
}
