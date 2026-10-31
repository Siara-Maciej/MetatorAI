import { MetatorError } from "../domain/errors.ts";
import { FindingSetDocument, type LENSES } from "../domain/finding.ts";
import { matchesAny } from "../domain/glob.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { authorsOf, type ReviewMetadata, ReviewMetadataDocument } from "../domain/review-metadata.ts";
import { DEFAULT_LENSES, type ReviewPlan, ReviewPlanDocument, shardFiles } from "../domain/review-plan.ts";
import { rulesFor } from "../domain/rule.ts";
import { METATOR_FILES } from "../domain/system-impact.ts";
import {
  judge,
  type ReviewComment,
  type ReviewRole,
  toComments,
  type Verdict,
  VerdictDocument,
} from "../domain/verdict.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { BranchHistory, ChangePatch, FileSystem, Vcs, WorkspaceReader } from "../ports/index.ts";
import { cardFile } from "./cards.ts";
import type { MetatorPaths } from "./paths.ts";
import type { RuleCatalog } from "./rules.ts";

type Lens = (typeof LENSES)[number];

/** `review plan`: the changed files split into shards per package, with card and rules per shard. */
export class PlanReview {
  constructor(
    private readonly vcs: Vcs,
    private readonly workspace: WorkspaceReader,
    private readonly rules: RuleCatalog,
    private readonly fs: FileSystem,
    private readonly paths: MetatorPaths,
    private readonly ignores: readonly string[],
  ) {}

  async execute(input: {
    readonly base?: string;
    readonly files?: readonly string[];
    readonly lenses?: readonly Lens[];
    readonly maxFiles: number;
    readonly out?: string;
  }): Promise<Result<ReviewPlan, MetatorError>> {
    let files = input.files;
    if (!files) {
      const changed = await this.vcs.changedFiles(input.base ?? "HEAD");
      if (changed.isErr()) return err(changed.error);
      files = changed.value;
    }
    const reviewable: string[] = [];
    for (const f of files) {
      if (this.ignores.length > 0 && matchesAny(f, this.ignores)) continue;
      // MetatorAI's own files (host files, canon, cards) are no code to review.
      if (matchesAny(f, METATOR_FILES)) continue;
      if (await this.fs.exists(f)) reviewable.push(f); // deleted files have no code to review
    }
    const packages = await this.workspace.packages();
    if (packages.isErr()) return err(packages.error);
    const canon = (await this.rules.scan()).rules.map((r) => r.rule);
    const lenses = [...(input.lenses ?? DEFAULT_LENSES)];

    const shards: ReviewPlan["shards"] = [];
    for (const s of shardFiles(reviewable, packages.value, input.maxFiles)) {
      const card = cardFile(this.paths.cards, s.package);
      shards.push({
        ...s,
        card: (await this.fs.exists(card)) ? card : null,
        rules: rulesFor(canon, s.files).map((r) => r.id),
      });
    }
    const plan: ReviewPlan = {
      files: reviewable.sort(),
      lenses,
      shards,
      tasks: shards.length * lenses.length,
    };
    if (input.out) {
      const saved = await this.fs.write(input.out, serializeJsonDocument(ReviewPlanDocument.stamp(plan)));
      if (saved.isErr()) return err(saved.error);
    }
    return ok(plan);
  }
}

const parent = (dir: string) => dir.replace(/\/$/, "").replace(/\/[^/]*$/, "") || ".";
/** Where the verdict goes: a run's own directory when the findings are anywhere in one (its stage produces it there), else next to them. */
const verdictDir = (dir: string) =>
  /^(.*?(?:^|\/)\.metator\/runs\/[^/]+)(?:\/|$)/.exec(dir)?.[1] ?? parent(dir);

/** `findings verdict`: the decision from merged findings, written next to the findings directory. */
export class JudgeFindings {
  constructor(private readonly fs: FileSystem) {}

  async execute(input: {
    readonly dir: string;
    readonly verifiedCorrect: readonly string[];
  }): Promise<Result<Verdict & { readonly output: string }, MetatorError>> {
    const source = `${input.dir.replace(/\/$/, "")}/merged.json`;
    const text = await this.fs.read(source);
    if (text.isErr()) {
      return err(
        new MetatorError("NOT_FOUND", `${source} not found`, {
          hint: `Run \`metator findings merge ${input.dir}\` first.`,
        }),
      );
    }
    const set = parseJsonDocument(text.value, source).andThen((raw) => FindingSetDocument.parse(raw, source));
    if (set.isErr()) return err(set.error);
    const verdict = judge(set.value.findings, input.verifiedCorrect);
    const output = `${verdictDir(input.dir)}/verdict.json`;
    const saved = await this.fs.write(output, serializeJsonDocument(VerdictDocument.stamp(verdict)));
    if (saved.isErr()) return err(saved.error);
    return ok({ ...verdict, output });
  }
}

/** `findings to-github`: comments and summary from the verdict; posting is the agent's job, after approval. */
export class FormatReviewComments {
  constructor(private readonly fs: FileSystem) {}

  async execute(input: {
    readonly verdict: string;
    readonly format: "natural" | "labeled";
    readonly role?: ReviewRole;
  }): Promise<
    Result<
      {
        readonly decision: Verdict["decision"];
        readonly comments: readonly ReviewComment[];
        readonly summary: string;
      },
      MetatorError
    >
  > {
    const text = await this.fs.read(input.verdict);
    if (text.isErr()) return err(text.error);
    const verdict = parseJsonDocument(text.value, input.verdict).andThen((raw) =>
      VerdictDocument.parse(raw, input.verdict),
    );
    if (verdict.isErr()) return err(verdict.error);
    if (verdict.value.decision === "NEEDS_VERIFICATION") {
      return err(
        MetatorError.usage(
          "The verdict is not decided yet",
          "Verify the unverified blocking findings, then run `metator findings verdict` again.",
        ),
      );
    }
    return ok({ decision: verdict.value.decision, ...toComments(verdict.value, input.format, input.role) });
  }
}

/** `review metadata` (pr.json): the branch, its commits and authors, the files; from git. */
export class DescribeReviewedChange {
  constructor(
    private readonly vcs: Pick<Vcs, "changedFiles">,
    private readonly history: BranchHistory,
    private readonly fs: FileSystem,
  ) {}

  async execute(input: {
    readonly base: string;
    readonly out?: string;
  }): Promise<Result<ReviewMetadata, MetatorError>> {
    const branch = await this.history.branch(input.base);
    if (branch.isErr()) return err(branch.error);
    const files = await this.vcs.changedFiles(input.base);
    if (files.isErr()) return err(files.error);
    const commits = branch.value.commits.map((c) => ({ ...c }));
    const metadata: ReviewMetadata = {
      base: input.base,
      branch: branch.value.branch,
      head: branch.value.head,
      mergeBase: branch.value.mergeBase,
      commits,
      authors: authorsOf(commits),
      files: [...files.value],
      uncommitted: branch.value.uncommitted,
    };
    if (input.out) {
      const saved = await this.fs.write(
        input.out,
        serializeJsonDocument(ReviewMetadataDocument.stamp(metadata)),
      );
      if (saved.isErr()) return err(saved.error);
    }
    return ok(metadata);
  }
}

/** `review diff`: the change as a unified diff, without MetatorAI's own files, for a reviewer to read. */
export class ShowChangeDiff {
  constructor(private readonly changes: ChangePatch & Pick<Vcs, "changedFiles">) {}

  async execute(input: {
    readonly base: string;
    readonly files?: readonly string[];
  }): Promise<Result<{ base: string; files: string[]; patch: string }, MetatorError>> {
    let files = input.files ? [...input.files] : undefined;
    if (!files) {
      const changed = await this.changes.changedFiles(input.base);
      if (changed.isErr()) return err(changed.error);
      files = changed.value.filter((f) => !matchesAny(f, METATOR_FILES));
    }
    if (files.length === 0) return ok({ base: input.base, files, patch: "" });
    const patch = await this.changes.patch(input.base, files);
    if (patch.isErr()) return err(patch.error);
    return ok({ base: input.base, files, patch: patch.value });
  }
}
