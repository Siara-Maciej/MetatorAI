import { err, MetatorError, ok } from "@metator/core";
import type { Command } from "commander";
import type { CommandContext } from "../context.ts";

export function registerContractCommands(program: Command, ctx: CommandContext): void {
  const { action, container } = ctx;
  const contract = program
    .command("contract")
    .description("The contracts this repository provides: what a change does to them");

  contract
    .command("diff")
    .description(
      "Each provided contract's specification since a base: breaking or not, judged by the map's policy",
    )
    .option("--base <ref>", "compare with the merge base of this ref", "HEAD")
    .option("--contracts <ids...>", "only these contracts")
    .option("--check", "fail when a change breaks a contract the map's policy protects", false)
    .action(
      action(async (opts: { base: string; contracts?: string[]; check: boolean }) => {
        const r = await container()
          .resolve("diffContracts")
          .execute({ base: opts.base, ...(opts.contracts ? { contracts: opts.contracts } : {}) });
        if (r.isErr()) return { result: r };
        const failing = r.value.contracts.filter((c) => !c.allowed);
        const warnings = r.value.contracts.flatMap((c) =>
          !c.allowed || !c.reason || c.status === "unchanged" ? [] : [`${c.id}: ${c.reason}`],
        );
        if (opts.check && failing.length > 0)
          return {
            result: err(
              new MetatorError(
                "CHECK_FAILED",
                `${failing.length} contract(s) broken: ${r.value.failing.join(", ")}`,
                {
                  hint: "Follow the map's breaking policy (policies.breaking), or set the contract's compatibility to none.",
                  details: { ...r.value },
                },
              ),
            ),
          };
        return {
          result: ok(r.value),
          warnings: [...failing.map((c) => `${c.id}: ${c.reason ?? c.status}`), ...warnings],
        };
      }),
    );
}
