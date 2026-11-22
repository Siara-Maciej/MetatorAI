import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { err, MetatorError, ok, type Result, SystemMapDocument } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext, Folder } from "../context.ts";
import { baseOption, byOption } from "../options.ts";
import { schemaCommand } from "../outcome.ts";
import { asPerson } from "../who.ts";
import { registerSystemPlanCommands } from "./system-plan.ts";

export function registerSystemCommands(program: Command, ctx: CommandContext): void {
  const { action, container } = ctx;
  const system = meta(program.command("system"), { audience: "person" }).description(
    "The system landscape: applications, the contracts between them, deploy order",
  );

  meta(system.command("show"), { reads: true })
    .description("The system map with each contract's provider and consumers, and the deploy waves")
    .action(action(async () => ({ result: await container().resolve("showSystem").execute() })));

  meta(system.command("lint"), { audience: "ci", reads: true, writesWith: ["--fetch"], check: [] })
    .description("Owners, consumed contracts, contract kinds, deploy cycles and the specifications")
    .option(
      "--fetch",
      "clone other repositories that have no local checkout to check their specifications",
      false,
    )
    .action(
      action(async (opts: { fetch: boolean }) => {
        const report = await container()
          .resolve("lintSystem")
          .execute(opts.fetch ? { fetch: true } : {});
        if (report.isErr()) return { result: report };
        const errors = report.value.problems.filter((p) => p.severity === "error");
        if (errors.length > 0) {
          return {
            result: err(
              new MetatorError("CHECK_FAILED", `${errors.length} problem(s) in ${report.value.source}`, {
                hint: "Fix the map or the files it names; `metator system schema` prints the format.",
                details: { ...report.value },
              }),
            ),
          };
        }
        const warnings = report.value.problems.filter((p) => p.severity === "warning").map((p) => p.message);
        return { result: ok(report.value), ...(warnings.length > 0 ? { warnings } : {}) };
      }),
    );

  meta(system.command("impact"), { reads: true })
    .description("Where a change lands: changed files or named contracts → contracts → consumers → owners")
    .addOption(baseOption("the files changed since the merge base with this ref", "HEAD"))
    .option("--files <files...>", "these files instead of git")
    .option("--contracts <ids...>", "contracts the change touches, by id")
    .action(
      action(async (opts: { base: string; files?: string[]; contracts?: string[] }) => ({
        result: await container()
          .resolve("systemImpactQuery")
          .execute({
            ...(opts.files ? { files: opts.files } : { base: opts.base }),
            ...(opts.contracts ? { contracts: opts.contracts } : {}),
          }),
      })),
    );

  meta(system.command("sources"), { reads: true, writesWith: ["--fetch"] })
    .description("Where each application's code is on this machine: here, a checkout or a pinned clone")
    .option("--fetch", "clone what has no local checkout", false)
    .action(
      action(async (opts: { fetch: boolean }) => {
        const r = await container()
          .resolve("systemSources")
          .locateAll(opts.fetch ? { fetch: true } : {});
        return {
          result: r,
          warnings: r.isOk()
            ? r.value.sources
                .filter((x) => x.via === "none")
                .map((x) => `${x.app} has no checkout here: set system.roots.${x.app} or pass --fetch`)
            : [],
        };
      }),
    );

  meta(system.command("discover"), { folder: true })
    .description("Propose a system map from the code: applications, contracts and consumers, with evidence")
    .option("--write", "write the proposal to the map file when there is none (never overwrites)", false)
    .option("--check", "fail when the map lacks what the code shows", false)
    .option(
      "--repo <name>",
      "in a folder, with --write: the repository that holds the map (default: the one that has one, else the first)",
    )
    .addOption(byOption("who writes the map (with --write)"))
    .action(
      action(async (opts: { write: boolean; check: boolean; repo?: string; by?: string }) => {
        const f = ctx.folder();
        // A folder's map lives in one of its repositories (the platform's): the proposal from every
        // repository of the folder is written there, as the app's Discover does (never overwrites).
        if (f && opts.write) {
          const holder = mapHolder(
            f,
            opts.repo,
            (root) => ctx.containerAt(root).resolve("systemCatalog").source,
          );
          if (holder.isErr()) return { result: holder };
          const c = ctx.containerAt(holder.value.root);
          return asPerson(c, opts.by, async (by) => ({
            result: (
              await c.resolve("systemMaps").discover({
                write: true,
                by,
                folder: { root: f.root, repos: f.repos.map((r) => r.root) },
              })
            ).map((v) => ({ ...v, repo: holder.value.name })),
          }));
        }
        if (f && opts.check)
          return {
            result: err(
              MetatorError.usage(
                "--check needs a map, and a folder of repositories has none of its own",
                "Run it in the repository that holds the map.",
              ),
            ),
          };
        const c = f ? ctx.containerAt(f.root) : container();
        const sources = f
          ? f.repos.map((r) => ctx.containerAt(r.root).resolve("discoverySource"))
          : [c.resolve("discoverySource")];
        const catalog = c.resolve("systemCatalog");
        const r = await c.resolve("discoverSystem").execute({
          sources,
          system: basename(f ? f.root : c.resolve("root")),
          ...(f
            ? {}
            : { map: { file: catalog.source, load: () => catalog.load(), fs: c.resolve("fileSystem") } }),
          ...(opts.write ? { write: true } : {}),
        });
        // An empty proposal is not "nothing to map": say what discovery looks for.
        const none =
          r.isOk() && r.value.proposal.applications.length === 0
            ? [
                "no application was found: no package runs on its own (a `bin`, a start, dev or serve script, a folder under apps/) and none has a Dockerfile. Add the applications to the map by hand, or give a package `kind: app` in the architecture policy.",
              ]
            : [];
        // What the map lacks goes out once, in the envelope's warnings (in the error's details with --check).
        if (r.isErr() || !opts.check || r.value.drift.length === 0)
          return {
            result: r.map(({ drift: _, ...found }) => found),
            warnings: r.isOk() ? [...none, ...r.value.drift] : [],
          };
        return {
          result: err(
            new MetatorError(
              "CHECK_FAILED",
              `${r.value.drift.length} thing(s) the code shows are not in ${r.value.map}`,
              {
                hint: "Add them to the map (or remove what is gone from the code).",
                details: { drift: r.value.drift },
              },
            ),
          ),
        };
      }),
    );

  registerSystemPlanCommands(system, ctx);

  schemaCommand(system, ctx, "Print the JSON Schema of the system map", SystemMapDocument);
}

/** The repository of a folder that holds (or is to hold) the system map: named, else the one with a map, else the first. */
function mapHolder(
  f: Folder,
  named: string | undefined,
  mapFile: (root: string) => string,
): Result<Folder["repos"][number], MetatorError> {
  if (named) {
    const repo = f.repos.find((r) => r.name === named);
    return repo
      ? ok(repo)
      : err(
          MetatorError.usage(
            `no repository ${named} in ${f.root}`,
            `Its repositories: ${f.repos.map((r) => r.name).join(", ")}.`,
          ),
        );
  }
  for (const r of f.repos) if (existsSync(join(r.root, mapFile(r.root)))) return ok(r);
  const first = f.repos[0];
  return first ? ok(first) : err(MetatorError.usage(`${f.root} holds no repository`));
}
