import { AnswerPoliciesDocument, type AnswerPolicy } from "../domain/answer-policy.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, type Result } from "../domain/result.ts";
import type { FileSystem } from "../ports/index.ts";
import { readDocument, writeDocument } from "./document-io.ts";

/** Where the repository keeps its answer policies, reviewed like code. */
export const ANSWER_POLICIES_FILE = "metator/answer-policies.yml";

/** `metator/answer-policies.yml`: read, added to, removed from (P5). */
export class AnswerPolicyStore {
  constructor(
    private readonly fs: FileSystem,
    private readonly file: string = ANSWER_POLICIES_FILE,
  ) {}

  async list(): Promise<Result<readonly AnswerPolicy[], MetatorError>> {
    const doc = await readDocument(this.fs, this.file, AnswerPoliciesDocument, "yaml");
    return doc.map((d) => d?.policies ?? []);
  }

  async add(policy: AnswerPolicy): Promise<Result<AnswerPolicy, MetatorError>> {
    const all = await this.list();
    if (all.isErr()) return err(all.error);
    if (all.value.some((p) => p.id === policy.id))
      return err(MetatorError.usage(`answer policy ${policy.id} exists already`));
    const saved = await this.save([...all.value, policy]);
    return saved.map(() => policy);
  }

  async remove(id: string): Promise<Result<AnswerPolicy, MetatorError>> {
    const all = await this.list();
    if (all.isErr()) return err(all.error);
    const gone = all.value.find((p) => p.id === id);
    if (!gone)
      return err(
        MetatorError.notFound(`answer policy ${id}`, { hint: "`metator policy list` shows the policies." }),
      );
    const saved = await this.save(all.value.filter((p) => p.id !== id));
    return saved.map(() => gone);
  }

  private save(policies: readonly AnswerPolicy[]): Promise<Result<void, MetatorError>> {
    return writeDocument(
      this.fs,
      this.file,
      AnswerPoliciesDocument,
      { policies: [...policies] },
      "yaml",
      "Answer policies: each answers one kind of question for the team. Review changes like code.",
    );
  }
}
