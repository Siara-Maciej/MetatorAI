import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  err,
  MetatorError,
  ok,
  proposeRepoSet,
  REPO_SET_FILE,
  RepoSetDocument,
  renderYamlDocument,
} from "@metator/core";
import { findChildRepos } from "@metator/runtime";
import type { Command } from "commander";
import type { CommandContext, Folder } from "../context.ts";
import { sessionRows } from "../sessions.ts";

const CONFIGS = ["metator.config.yml", "metator.config.yaml", "metator.config.json", "metator.config.ts"];

/** `repos *` (G2, ADR-0057): a folder of repositories, each with its own MetatorAI. */
export function registerReposCommands(program: Command, ctx: CommandContext): void {
  const { action, folder } = ctx;
  const repos = program
    .command("repos")
    .description("A folder of repositories: list them, see their work, write metator.repos.yml");

  repos
    .command("init")
    .description(`Write ${REPO_SET_FILE} in this folder from the repositories below it (never overwrites)`)
    .option("--dry-run", "print the proposal without writing it", false)
    .action(
      action(async (opts: { dryRun: boolean }) => {
        const here = resolve((program.opts() as { root?: string }).root ?? process.cwd());
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
        const found = findChildRepos(here);
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

  repos
    .command("list")
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
              setUp: CONFIGS.some((c) => existsSync(join(r.root, c))),
            })),
          }),
        };
      }),
    );

  repos
    .command("status")
    .description("Each repository's work: active runs, questions waiting for you, running services")
    .action(
      action(async () => {
        const f = needFolder(folder());
        if (f.isErr()) return { result: f };
        const out = [];
        const warnings: string[] = [];
        for (const r of f.value.repos) {
          try {
            const c = ctx.containerAt(r.root);
            const rows = await sessionRows(c);
            const active = rows.isOk() ? rows.value.filter((s) => s.status === "active") : [];
            const services = existsSync(join(r.root, c.resolve("paths").environment))
              ? await c.resolve("environmentServices").status({})
              : ok([]);
            out.push({
              name: r.name,
              path: r.path,
              runs: active.length,
              waiting: active.reduce((n, s) => n + s.waiting, 0),
              driving: active.filter((s) => s.driving).length,
              services: services.isOk() ? services.value.filter((s) => s.status === "running").length : 0,
              sessions: active.map((s) => ({ runId: s.runId, stage: s.stage, state: s.state })),
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
