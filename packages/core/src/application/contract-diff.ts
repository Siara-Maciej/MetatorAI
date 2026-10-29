import {
  type ContractChange,
  type ContractVerdict,
  judgeContract,
  statusOf,
} from "../domain/contract-diff.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  type Application,
  type Contract,
  consumersOf,
  type SystemMap,
  specPath,
} from "../domain/system-map.ts";
import type { ContractDiffer, ReadonlyFileSystem, RevisionReader } from "../ports/index.ts";
import type { SystemSources } from "./system-sources.ts";

export interface ContractDiffEntry extends ContractVerdict {
  readonly id: string;
  readonly kind: string;
  readonly owner: string;
  /** The specification in this repository. */
  readonly spec: string;
  readonly versions: { readonly before?: string; readonly after?: string };
  readonly changes: readonly ContractChange[];
}

/** A breaking change someone planned and approved (a system plan): why it may pass. */
export interface BreakingAllowance {
  allows(contract: string, owner: string): Promise<Result<string | undefined, MetatorError>>;
}

export interface ContractDiffReport {
  readonly map: string;
  readonly base: string;
  readonly contracts: readonly ContractDiffEntry[];
  /** Contracts whose change the map's policy does not allow. */
  readonly failing: readonly string[];
}

/**
 * `contract diff` (F7.4): every contract this repository provides (or the ones named), its
 * specification at the merge base with `base` against the working tree, compared by the
 * contract kind's differ and judged by the map's compatibility and breaking policy, and by the
 * approved system plans (a planned breaking change passes when its step is next).
 */
export class DiffContracts {
  constructor(
    private readonly sources: Pick<SystemSources, "self" | "location">,
    private readonly revisions: Pick<RevisionReader, "readAt">,
    private readonly fs: Pick<ReadonlyFileSystem, "read" | "exists">,
    private readonly differs: readonly ContractDiffer[],
    private readonly planned: BreakingAllowance,
  ) {}

  async execute(input: {
    readonly base: string;
    readonly contracts?: readonly string[];
  }): Promise<Result<ContractDiffReport, MetatorError>> {
    const map = await this.sources.location.require();
    if (map.isErr()) return err(map.error);
    const self = await this.sources.self(map.value);
    if (self.isErr()) return err(self.error);
    const chosen = choose(map.value, new Map(self.value.map((a) => [a.id, a])), input.contracts);
    if (chosen.isErr()) return err(chosen.error);
    const entries: ContractDiffEntry[] = [];
    for (const { contract, owner } of chosen.value) {
      const entry = await this.diff(map.value, contract, owner, input.base);
      if (entry.isErr()) return err(entry.error);
      entries.push(entry.value);
    }
    return ok({
      map: this.sources.location.source,
      base: input.base,
      contracts: entries,
      failing: entries.filter((e) => !e.allowed).map((e) => e.id),
    });
  }

  private async diff(
    map: SystemMap,
    contract: Contract,
    owner: Application,
    base: string,
  ): Promise<Result<ContractDiffEntry, MetatorError>> {
    const spec = specPath(owner, contract);
    const before = await this.revisions.readAt(base, spec);
    if (before.isErr()) return err(before.error);
    let after: string | undefined;
    if (await this.fs.exists(spec)) {
      const text = await this.fs.read(spec);
      if (text.isErr()) return err(text.error);
      after = text.value;
    }
    let changes: readonly ContractChange[] = [];
    let versions: { before?: string; after?: string } = {};
    if (before.value !== undefined && after !== undefined && before.value !== after) {
      const differ = this.differs.find((d) => d.kind === contract.kind);
      if (!differ)
        changes = [
          {
            code: "kind.unsupported",
            severity: "unclassified",
            location: spec,
            message: `no differ for contract kind ${contract.kind}`,
          },
        ];
      else {
        const compared = await differ.compare(
          { path: spec, text: before.value },
          { path: spec, text: after },
        );
        if (compared.isErr()) return err(compared.error);
        changes = compared.value.changes;
        versions = { ...compared.value.versions };
      }
    }
    const status = statusOf(changes, { before: before.value !== undefined, after: after !== undefined });
    let verdict = judgeContract({
      contract,
      policies: map.policies,
      status,
      versions,
      consumers: consumersOf(map, contract.id),
    });
    if (!verdict.allowed) {
      const why = await this.planned.allows(contract.id, contract.owner);
      if (why.isErr()) return err(why.error);
      if (why.value)
        verdict = { ...verdict, allowed: true, reason: `${why.value}; ${verdict.reason ?? ""}`.trim() };
    }
    return ok({
      id: contract.id,
      kind: contract.kind,
      owner: contract.owner,
      spec,
      versions,
      changes,
      ...verdict,
    });
  }
}

/** The contracts to compare: those this repository provides, or the ones named (provided here). */
function choose(
  map: SystemMap,
  mine: ReadonlyMap<string, Application>,
  named: readonly string[] | undefined,
): Result<{ contract: Contract; owner: Application }[], MetatorError> {
  const provided = (c: Contract) => {
    const owner = mine.get(c.owner);
    return owner ? { contract: c, owner } : undefined;
  };
  if (!named) return ok(map.contracts.flatMap((c) => provided(c) ?? []));
  const out: { contract: Contract; owner: Application }[] = [];
  for (const id of named) {
    const c = map.contracts.find((x) => x.id === id);
    if (!c)
      return err(
        MetatorError.usage(
          `unknown contract ${id}`,
          `Contracts: ${map.contracts.map((x) => x.id).join(", ")}.`,
        ),
      );
    const pair = provided(c);
    if (!pair)
      return err(
        MetatorError.usage(
          `${id} is provided by ${c.owner}, not by this repository`,
          "Run `contract diff` in the provider's repository; `system impact --contracts` works from anywhere.",
        ),
      );
    out.push(pair);
  }
  return ok(out);
}
