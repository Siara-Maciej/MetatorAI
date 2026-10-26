import { stringify } from "yaml";
import { CONFIG_FILES, DEFAULT_CONFIG, type GateStep, MetatorConfigDocument } from "../domain/config.ts";
import { MetatorError } from "../domain/errors.ts";
import { type Decision, proposeConfig } from "../domain/proposal.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { FileSystem } from "../ports/index.ts";
import type { Discover } from "./discover.ts";
import type { MetatorPaths } from "./paths.ts";

export interface InitReport {
  /** The config file written, or null for a dry run. */
  readonly written: string | null;
  readonly config: string;
  readonly decisions: readonly Decision[];
  readonly warnings: readonly string[];
}

/** `metator init`: discovery, then a config proposal written as metator.config.yml (never overwritten). */
export class InitProject {
  constructor(
    private readonly discover: Pick<Discover, "execute">,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async execute(input: { readonly dryRun: boolean }): Promise<Result<InitReport, MetatorError>> {
    for (const file of CONFIG_FILES) {
      if (!input.dryRun && (await this.fs.exists(file))) {
        return err(
          MetatorError.usage(
            `${file} already exists`,
            "Edit it, or compare with `metator init --dry-run`; init never overwrites.",
          ),
        );
      }
    }
    const discovery = await this.discover.execute();
    if (discovery.isErr()) return err(discovery.error);
    const ruleCanon = (await this.fs.glob([`${this.paths.rules}/*.yml`])).length > 0;
    const proposal = proposeConfig(discovery.value, { ruleCanon });
    // Only what differs from the defaults, so the file stays short and reviewable.
    const minimal = (steps: readonly GateStep[]) =>
      steps.map((st) => ({
        id: st.id,
        run: st.run,
        ...(st.files === "append" ? { files: st.files } : {}),
        ...(st.match ? { match: st.match } : {}),
      }));
    const header = MetatorConfigDocument.stamp(DEFAULT_CONFIG);
    const body = {
      kind: header.kind,
      schemaVersion: header.schemaVersion,
      gates: { quick: minimal(proposal.gates.quick), full: minimal(proposal.gates.full) },
    };
    const text = `# Proposed by \`metator init\` from .metator/discovery.json; every choice is in its report.\n${stringify(body, { lineWidth: 0 })}`;
    const file = "metator.config.yml";
    if (!input.dryRun) {
      const saved = await this.fs.write(file, text);
      if (saved.isErr()) return err(saved.error);
    }
    const warnings = [...discovery.value.warnings];
    if (proposal.gates.quick.length === 0)
      warnings.push("no file-scoped checks found for the quick gate; add one by hand");
    return ok({ written: input.dryRun ? null : file, config: text, decisions: proposal.decisions, warnings });
  }
}
