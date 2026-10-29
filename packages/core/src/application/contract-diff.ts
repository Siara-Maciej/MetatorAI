import type { SystemSettings } from "../domain/config.ts";
import {
  type ContractChange,
  type ContractStatus,
  type ContractVerdict,
  judgeContract,
  statusOf,
} from "../domain/contract-diff.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { appDir } from "../domain/system-impact.ts";
import { type Application, type Contract, parseConsumes, type SystemMap } from "../domain/system-map.ts";
import type { ContractDiffer, ReadonlyFileSystem, RevisionReader, Vcs } from "../ports/index.ts";
import { type SystemLocation, selfOf } from "./system-sources.ts";

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
  allows(contract: string): Promise<Result<string | undefined, MetatorError>>;
}

export interface ContractDiffReport {
  readonly map: string;
  readonly base: string;
  readonly contracts: readonly ContractDiffEntry[];
  /** Contracts whose change the map's policy does not allow. */
  readonly failing: readonly string[];
}

const join = (dir: string, path: string) => (dir === "." ? path : `${dir.replace(/\/+$/, "")}/${path}`);

/**
 * `contract diff` (F7.4): every contract this repository provides (or the ones named), its
 * specification at the merge base with `base` against the working tree, compared by the
 * contract kind's differ and judged by the map's compatibility and breaking policy.
 */
export class DiffContracts {
  constructor(
    private readonly location: SystemLocation,
    private readonly vcs: Pick<Vcs, "remoteUrl">,
    private readonly revisions: Pick<RevisionReader, "readAt">,
    private readonly fs: Pick<ReadonlyFileSystem, "read" | "exists">,
    private readonly differs: readonly ContractDiffer[],
    private readonly settings: SystemSettings | undefined,
    private readonly here: string,
    private readonly planned?: BreakingAllowance,
  ) {}

  async execute(input: {
    readonly base: string;
    readonly contracts?: readonly string[];
  }): Promise<Result<ContractDiffReport, MetatorError>> {
    const map = await this.location.load();
    if (map.isErr()) return err(map.error);
    if (!map.value)
      return err(
        MetatorError.notFound(`a system map at ${this.location.source}`, {
          hint: "`metator system discover --write` proposes one.",
        }),
      );
    const self = await selfOf(map.value, this.location, this.vcs, this.settings, this.here);
    if (self.isErr()) return err(self.error);
    const mine = new Map(self.value.map((a) => [a.id, a]));
    const chosen = this.choose(map.value, mine, input.contracts);
    if (chosen.isErr()) return err(chosen.error);
    const entries: ContractDiffEntry[] = [];
    for (const contract of chosen.value) {
      const entry = await this.diff(map.value, contract, mine.get(contract.owner) as Application, input.base);
      if (entry.isErr()) return err(entry.error);
      entries.push(entry.value);
    }
    return ok({
      map: this.location.source,
      base: input.base,
      contracts: entries,
      failing: entries.filter((e) => !e.allowed).map((e) => e.id),
    });
  }

  private choose(
    map: SystemMap,
    mine: ReadonlyMap<string, Application>,
    named: readonly string[] | undefined,
  ): Result<Contract[], MetatorError> {
    if (!named) return ok(map.contracts.filter((c) => mine.has(c.owner)));
    const out: Contract[] = [];
    for (const id of named) {
      const c = map.contracts.find((x) => x.id === id);
      if (!c)
        return err(
          MetatorError.usage(
            `unknown contract ${id}`,
            `Contracts: ${map.contracts.map((x) => x.id).join(", ")}.`,
          ),
        );
      if (!mine.has(c.owner))
        return err(
          MetatorError.usage(
            `${id} is provided by ${c.owner}, not by this repository`,
            "Run `contract diff` in the provider's repository; `system impact --contracts` works from anywhere.",
          ),
        );
      out.push(c);
    }
    return ok(out);
  }

  private async diff(
    map: SystemMap,
    contract: Contract,
    owner: Application,
    base: string,
  ): Promise<Result<ContractDiffEntry, MetatorError>> {
    const spec = join(appDir(owner), contract.spec.path);
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
    let status: ContractStatus = statusOf([], {
      before: before.value !== undefined,
      after: after !== undefined,
    });
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
      status = statusOf(changes, { before: true, after: true });
    }
    const consumers = map.applications.flatMap((a) =>
      a.consumes
        .map(parseConsumes)
        .filter((p) => p.contract === contract.id)
        .map((p) => ({ app: a.id, ...(p.version ? { range: p.version } : {}) })),
    );
    let verdict = judgeContract({ contract, policies: map.policies, status, versions, consumers });
    if (!verdict.allowed && this.planned) {
      const why = await this.planned.allows(contract.id);
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
