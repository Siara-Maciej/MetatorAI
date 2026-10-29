import { basename } from "node:path";
import { err, MetatorError, ok, SystemMapDocument } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerSystemCommands(program: Command, ctx: CommandContext): void {
  const { action, container } = ctx;
  const system = program
    .command("system")
    .description("The system landscape: applications, the contracts between them, deploy order");

  system
    .command("show")
    .description("The system map with each contract's provider and consumers, and the deploy waves")
    .action(action(async () => ({ result: await container().resolve("showSystem").execute() })));

  system
    .command("lint")
    .description("Owners, consumed contracts, contract kinds, deploy cycles and the files in this repository")
    .action(
      action(async () => {
        const report = await container().resolve("lintSystem").execute();
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

  system
    .command("discover")
    .description("Propose a system map from the code: applications, contracts and consumers, with evidence")
    .option("--write", "write the proposal to the map file when there is none (never overwrites)", false)
    .option("--check", "fail when the map lacks what the code shows", false)
    .action(
      action(async (opts: { write: boolean; check: boolean }) => {
        const f = ctx.folder();
        const c = f ? ctx.containerAt(f.root) : container();
        const sources = f
          ? f.repos.map((r) => ctx.containerAt(r.root).resolve("discoverySource"))
          : [c.resolve("discoverySource")];
        const catalog = c.resolve("systemCatalog");
        const r = await c.resolve("discoverSystem").execute({
          sources,
          system: basename(f ? f.root : c.resolve("root")),
          // A folder has no map of its own: the map lives in one repository (the platform's).
          ...(f
            ? {}
            : { map: { file: catalog.source, load: () => catalog.load(), fs: c.resolve("fileSystem") } }),
          ...(opts.write ? { write: true } : {}),
        });
        if (r.isErr() || !opts.check || r.value.drift.length === 0)
          return { result: r, warnings: r.isOk() ? [...r.value.drift] : [] };
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

  system
    .command("schema")
    .description("Print the JSON Schema of the system map")
    .action(action(async () => ({ result: ok(SystemMapDocument.jsonSchema("input")) })));
}
