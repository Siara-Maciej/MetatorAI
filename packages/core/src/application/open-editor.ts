import { editorArgv } from "../domain/editors.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { Launcher } from "../ports/index.ts";
import type { OptionStore } from "./options.ts";
import type { Panes } from "./panes.ts";
import type { RunJournal } from "./run-journal.ts";
import type { RunRepository } from "./run-repository.ts";

export interface OpenEditorDependencies {
  /** The repository's absolute root: a run without a worktree opens here. */
  readonly root: string;
  readonly repo: Pick<RunRepository, "resolveId" | "load">;
  readonly panes: Pick<Panes, "pane">;
  readonly options: Pick<OptionStore, "get">;
  readonly launcher: Pick<Launcher, "detached">;
  readonly journal: Pick<RunJournal, "record">;
}

export interface OpenEditorInput {
  /** The run whose worktree opens (the latest when neither a run nor a pane is given). */
  readonly runId?: string;
  /** A pane: its working directory opens, and its run is noted. */
  readonly paneId?: string;
  /** A file (repo-relative) and a line in it. */
  readonly file?: string;
  readonly line?: number;
}

/**
 * `metator open`, `POST /runs/:id/open-editor`, `POST /panes/:id/open-editor` (S5): the editor of
 * `editor.command` on the run's worktree (or the repository), at a file and line when asked;
 * VS Code reuses its window for the same directory. The run's activity notes it (origin inbox).
 */
export class OpenEditor {
  constructor(private readonly d: OpenEditorDependencies) {}

  async execute(
    input: OpenEditorInput,
  ): Promise<
    Result<{ readonly argv: readonly string[]; readonly dir: string; readonly runId?: string }, MetatorError>
  > {
    const where = await this.whereOf(input);
    if (where.isErr()) return err(where.error);
    const editor = await this.d.options.get("editor.command");
    if (editor.isErr()) return err(editor.error);
    const command = typeof editor.value.value === "string" ? editor.value.value.trim() : "";
    if (command === "")
      return err(
        MetatorError.usage("no editor is set", "`metator config set editor.command code --scope user`"),
      );
    const argv = editorArgv(command, {
      dir: where.value.dir,
      reuse: true,
      ...(input.file ? { file: input.file } : {}),
      ...(input.line ? { line: input.line } : {}),
    });
    const launched = await this.d.launcher.detached(argv, where.value.dir);
    if (launched.isErr()) return err(launched.error);
    if (where.value.runId) {
      const noted = await this.d.journal.record(where.value.runId, {
        type: "text",
        text: `opened in the editor: ${input.file ? `${input.file}${input.line ? `:${input.line}` : ""}` : where.value.dir}`,
        origin: "inbox",
      });
      if (noted.isErr()) return err(noted.error);
    }
    return ok({ argv, dir: where.value.dir, ...(where.value.runId ? { runId: where.value.runId } : {}) });
  }

  private async whereOf(
    input: OpenEditorInput,
  ): Promise<Result<{ readonly dir: string; readonly runId?: string }, MetatorError>> {
    if (input.paneId) {
      const pane = await this.d.panes.pane(input.paneId);
      if (pane.isErr()) return err(pane.error);
      return ok({ dir: pane.value.cwd, ...(pane.value.runId ? { runId: pane.value.runId } : {}) });
    }
    const id = await this.d.repo.resolveId(input.runId);
    if (id.isErr()) return err(id.error);
    const record = await this.d.repo.load(id.value);
    if (record.isErr()) return err(record.error);
    const w = record.value.worktree;
    return ok({ dir: w ? `${this.d.root}/${w.path}` : this.d.root, runId: id.value });
  }
}
