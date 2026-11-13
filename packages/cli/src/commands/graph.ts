import { err, MetatorError, normalizePath, ok } from "@metator/core";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";

/** Accepts `./src/a.ts` or `src\a.ts` as well as the canonical `src/a.ts`. */
const repoPath = (file: string): string => normalizePath(file).replace(/^(\.\/)+/, "");

export function registerGraphCommands(program: Command, { action, container }: CommandContext): void {
  program
    .command("index")
    .description("Maintain the incremental import index (.metator/index)")
    .command("build")
    .description("Parse changed source files, resolve every import and save the index")
    .action(
      action(async () => {
        const report = await container().resolve("buildImportGraph").execute();
        return {
          result: report.map((r) => ({
            files: r.files.length,
            edges: r.edges.length,
            crossPackageEdges: r.edges.filter((e) => e.kind === "cross-package").length,
            packages: r.packages.length,
            externals: r.externals,
            unresolved: r.unresolved,
            stats: r.stats,
          })),
          warnings: report.isOk()
            ? [...(report.value.notes ?? []), ...report.value.parseErrors.map((e) => e.message)]
            : [],
        };
      }),
    );

  const graph = meta(program.command("graph"), { reads: true }).description(
    "Query the file-level import graph",
  );

  meta(graph.command("affected"), { audience: "person" })
    .description("Files and tests affected by changes (against a git ref, or an explicit file list)")
    .option("--base <ref>", "git ref to compare against", "HEAD")
    .option("--files <files...>", "explicit changed files instead of git")
    .action(
      action(async (opts: { base: string; files?: string[] }) => {
        const affected = await container()
          .resolve("computeAffected")
          .execute(opts.files ? { changed: opts.files.map(repoPath) } : { base: opts.base });
        return { result: affected };
      }),
    );

  graph
    .command("callers")
    .description("Files that import an exported symbol, also through re-exports and barrels")
    .argument("<symbol>", "exported name")
    .option("--file <path>", "the file that defines it (when several files export the name)")
    .action(
      action(async (symbol: string, opts: { file?: string }) => ({
        result: await container()
          .resolve("symbolQueries")
          .callers(opts.file ? { name: symbol, file: repoPath(opts.file) } : { name: symbol }),
      })),
    );

  graph
    .command("diff")
    .description("Import edges added and removed since a base, new package dependencies and new cycles")
    .option("--base <ref>", "git ref to compare against (its merge base with HEAD)", "HEAD")
    .action(
      action(async (opts: { base: string }) => ({
        result: await container().resolve("diffImportGraph").execute({ base: opts.base }),
      })),
    );

  for (const [name, description] of [
    ["deps", "Files the given file imports"],
    ["dependents", "Files that import the given file"],
  ] as const) {
    meta(graph.command(name), name === "dependents" ? { audience: "person" } : {})
      .description(description)
      .argument("<file>", "repo-relative source file")
      .option("--transitive", "follow imports transitively", false)
      .action(
        action(async (file: string, opts: { transitive: boolean }) => {
          const queries = container().resolve("graphQueries");
          const path = repoPath(file);
          const files =
            name === "deps"
              ? await queries.dependencies(path, opts.transitive)
              : await queries.dependents(path, opts.transitive);
          return { result: files.map((list) => ({ file: path, transitive: opts.transitive, files: list })) };
        }),
      );
  }

  graph
    .command("cycles")
    .description("Import cycles (strongly connected components); type-only imports count")
    .option("--check", "fail when there is a cycle (CI, `bun run arch`)", false)
    .action(
      action(async (opts: { check: boolean }) => {
        const cycles = await container().resolve("graphQueries").cycles();
        if (cycles.isErr()) return { result: cycles };
        if (opts.check && cycles.value.length > 0)
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `${cycles.value.length} import cycle(s): ${cycles.value.map((c) => c.join(" ↔ ")).join("; ")}`,
                {
                  hint: "Break each cycle: move what both files need into a third one, or declare the type where it is used. `metator graph path <from> <to>` shows the chain; an `import type` is an edge too.",
                  details: { cycles: cycles.value },
                },
              ),
            ),
          };
        return { result: ok({ cycles: cycles.value }) };
      }),
    );

  graph
    .command("path")
    .description("Shortest import chain from one file to another (null when there is none)")
    .argument("<from>", "repo-relative source file")
    .argument("<to>", "repo-relative source file")
    .action(
      action(async (from: string, to: string) => ({
        result: (await container().resolve("graphQueries").path(repoPath(from), repoPath(to))).map(
          (path) => ({
            path,
          }),
        ),
      })),
    );

  graph
    .command("packages")
    .description("Cross-package import edges, counted per package pair")
    .action(
      action(async () => ({
        result: (await container().resolve("graphQueries").packageEdges()).map((edges) => ({ edges })),
      })),
    );

  meta(
    program.command("workspace").description("Inspect the repository's workspace packages").command("list"),
    { reads: true },
  )
    .description("Workspace packages (npm, yarn, pnpm, bun, lerna, rush)")
    .action(
      action(async () => ({
        result: (await container().resolve("workspaceReader").packages()).map((packages) => ({ packages })),
      })),
    );

  meta(program.command("symbols").description("Exported symbols").command("find"), {
    audience: "person",
    reads: true,
  })
    .description("Where an exported name is defined, and which modules re-export it")
    .argument("<name>", "exported name")
    .action(
      action(async (name: string) => ({ result: await container().resolve("symbolQueries").find(name) })),
    );
}
