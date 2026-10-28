import { err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerApiCommands(program: Command, { action, container }: CommandContext): void {
  const api = program
    .command("api")
    .description("A package's public API (declarations) before and after a change");

  api
    .command("snapshot")
    .description(
      "Save the package's API: declarations its entry reaches, normalized (.metator/api/<package>.json)",
    )
    .argument("[package]", "workspace package name, e.g. @metator/core (default: every package)")
    .action(
      action(async (pkg: string | undefined) => {
        const c = container();
        if (pkg) return { result: await c.resolve("apiSnapshots").snapshot({ package: pkg }) };
        // Without a package (a refactor's snapshot stage): every package of the workspace.
        const packages = await c.resolve("workspaceReader").packages();
        if (packages.isErr()) return { result: packages };
        const snapshots = [];
        for (const p of packages.value) {
          const snap = await c.resolve("apiSnapshots").snapshot({ package: p.name });
          if (snap.isErr()) return { result: snap };
          snapshots.push(snap.value);
        }
        return { result: ok({ snapshots }) };
      }),
    );

  api
    .command("diff")
    .description("Compare the package's API with its snapshot; any added or removed declaration fails")
    .argument("<package>", "workspace package name")
    .action(
      action(async (pkg: string) => {
        const diff = await container().resolve("apiSnapshots").diff({ package: pkg });
        if (diff.isErr()) return { result: diff };
        if (diff.value.changed) {
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `the public API of ${pkg} changed in ${diff.value.files.length} file(s)`,
                {
                  hint: "A refactor keeps the API; a planned change takes a new snapshot after review.",
                  details: { ...diff.value },
                },
              ),
            ),
          };
        }
        return { result: ok(diff.value) };
      }),
    );
}
