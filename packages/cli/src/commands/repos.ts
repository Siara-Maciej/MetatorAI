import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONFIG_FILES,
  err,
  MetatorError,
  ok,
  proposeRepoSet,
  REPO_SET_FILE,
  RepoSetDocument,
  renderYamlDocument,
} from "@metator/core";
import { findFolderRepos } from "@metator/runtime";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext, Folder } from "../context.ts";
import { sessionRows } from "../sessions.ts";

/** `repos *` (G2, ADR-0057): a folder of repositories, each with its own MetatorAI. */
export function registerReposCommands(program: Command, ctx: CommandContext): void {
  const { action, folder } = ctx;
  const repos = meta(program.command("repos"), { audience: "person" }).description(
    "A folder of repositories: list them, see their work, write metator.repos.yml",
  );

  meta(repos.command("init"), { folder: true })
    .description(`Write ${REPO_SET_FILE} in this folder from the repositories below it (never overwrites)`)
    .option("--dry-run", "print the proposal without writing it", false)
    .action(
      action(async (opts: { dryRun: boolean }) => {
        const here = resolve(ctx.start());
        const file = join(here, REPO_SET_FILE);
        if (!opts.dryRun && existsSync(file))
          return {
            result: err(
              MetatorError.usage(
                `${REPO_SET_FILE} already exists`,
                "Edit it; `repos init` never overwrites.",
              ),
            ),
          };
        // Worktrees of one repository are listed under it, not as more repositories.
        const found = findFolderRepos(here);
        if (found.length === 0)
          return {
            result: err(
              MetatorError.usage(
                `no repositories below ${here}`,
                "Run it in the folder that holds your repositories (each with its own .git).",
              ),
            ),
          };
        const set = proposeRepoSet(found);
        const text = renderYamlDocument(
          { ...RepoSetDocument.stamp(set) },
          "The repositories of this folder; each keeps its own MetatorAI (`metator repos list`).",
        );
        if (!opts.dryRun) await Bun.write(file, text);
        return { result: ok({ written: opts.dryRun ? null : file, repos: set.repos, text }) };
      }),
    );

  meta(repos.command("list"), { reads: true, folder: true })
    .description("The folder's repositories and whether MetatorAI is set up in each")
    .action(
      action(() => {
        const f = needFolder(folder());
        if (f.isErr()) return { result: f };
        return {
          result: ok({
            folder: f.value.root,
            file: f.value.file,
            repos: f.value.repos.map((r) => ({
              ...r,
              setUp: setUp(r.root),
              worktrees: r.worktrees.map((w) => ({ ...w, setUp: setUp(w.root) })),
            })),
          }),
        };
      }),
    );

  meta(repos.command("status"), { reads: true, folder: true })
    .description("Each repository's work: active runs, questions waiting for you, running services")
    .action(
      action(async () => {
        const f = needFolder(folder());
        if (f.isErr()) return { result: f };
        const out = [];
        const warnings: string[] = [];
        // A repository's work is the work of every checkout of it: its own and its worktrees'.
        for (const r of f.value.repos) {
          try {
            const places = f.value.checkouts.filter((p) => p.repo === r.name);
            let runs = 0;
            let waiting = 0;
            let driving = 0;
            let services = 0;
            const sessions: Record<string, unknown>[] = [];
            for (const place of places) {
              const c = ctx.containerAt(place.root);
              const rows = await sessionRows(c);
              const active = rows.isOk() ? rows.value.filter((s) => s.status === "active") : [];
              const up = existsSync(join(place.root, c.resolve("paths").environment))
                ? await c.resolve("environmentServices").status({})
                : ok([]);
              runs += active.length;
              waiting += active.reduce((n, s) => n + s.waiting, 0);
              driving += active.filter((s) => s.driving).length;
              services += up.isOk() ? up.value.filter((s) => s.status === "running").length : 0;
              for (const s of active)
                sessions.push({
                  runId: s.runId,
                  stage: s.stage,
                  state: s.state,
                  ...(place.worktreeOf ? { checkout: place.label } : {}),
                });
            }
            out.push({
              name: r.name,
              path: r.path,
              ...(r.worktrees.length > 0 ? { worktrees: r.worktrees.length } : {}),
              runs,
              waiting,
              driving,
              services,
              sessions,
            });
          } catch (e) {
            warnings.push(`${r.name}: ${(e as Error).message}`);
            out.push({ name: r.name, path: r.path, error: (e as Error).message });
          }
        }
        return { result: ok({ folder: f.value.root, repos: out }), warnings };
      }),
    );
}

const setUp = (root: string) => CONFIG_FILES.some((c) => existsSync(join(root, c)));

function needFolder(f: Folder | null) {
  return f
    ? ok(f)
    : err(
        MetatorError.usage(
          "this is a repository, not a folder of repositories",
          "Run `metator repos` in the folder that holds your repositories, or pass `-C <folder>`.",
        ),
      );
}
