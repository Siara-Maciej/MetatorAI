import type { AgentAnswer, AgentEvent, AgentQuestion, AgentTask } from "../domain/drive.ts";
import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  type DocumentHeader,
  parseYamlDocument,
  renderYamlDocument,
  type VersionedDocument,
} from "../domain/versioned.ts";
import type { AgentHost, FileSystem } from "../ports/index.ts";

/**
 * Documents with an id as versioned YAML files `<dir>/<id>.yml` (refactor and system plans):
 * a file's id must be its name. Files with a further dot (`<id>.analysis.yml`) are not listed.
 */
export class DocumentStore<T extends { readonly id: string }> {
  constructor(
    private readonly fs: FileSystem,
    readonly dir: string,
    private readonly doc: VersionedDocument<T>,
    private readonly text: { readonly noun: string; readonly listHint: string; readonly comment: string },
  ) {}

  file(id: string): string {
    return `${this.dir}/${id}.yml`;
  }

  async exists(id: string): Promise<boolean> {
    return this.fs.exists(this.file(id));
  }

  async load(id: string): Promise<Result<T, MetatorError>> {
    const file = this.file(id);
    if (!(await this.fs.exists(file)))
      return err(MetatorError.notFound(`${this.text.noun} ${id}`, { hint: this.text.listHint }));
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    const value = parseYamlDocument(text.value, file).andThen((raw) => this.doc.parse(raw, file));
    if (value.isOk() && value.value.id !== id)
      return err(new MetatorError("INVALID_CONFIG", `${file}: its id is ${value.value.id}, not ${id}`));
    return value;
  }

  async save(value: T): Promise<Result<void, MetatorError>> {
    const doc = { ...this.doc.stamp(value) } as DocumentHeader & Record<string, unknown>;
    return this.fs.write(this.file(value.id), renderYamlDocument(doc, this.text.comment));
  }

  async list(): Promise<Result<readonly T[], MetatorError>> {
    const out: T[] = [];
    for (const f of await this.fs.glob([`${this.dir}/*.yml`])) {
      const id = f.slice(f.lastIndexOf("/") + 1, -".yml".length);
      if (id.includes(".")) continue;
      const value = await this.load(id);
      if (value.isErr()) return err(value.error);
      out.push(value.value);
    }
    return ok(out.sort((a, b) => a.id.localeCompare(b.id)));
  }
}

/** One agent on the person's AI host until it stops; a failed result is COMMAND_FAILED with a hint. */
export async function runAgent(input: {
  readonly host: AgentHost;
  readonly hostName: string;
  readonly task: AgentTask;
  readonly deny: AgentAnswer;
  readonly hint: string;
  readonly onEvent?: (e: AgentEvent) => void;
  readonly ask?: (q: AgentQuestion) => Promise<AgentAnswer>;
}): Promise<Result<void, MetatorError>> {
  let failure: string | undefined;
  for await (const e of input.host.run(input.task, input.ask ?? (async () => input.deny))) {
    input.onEvent?.(e);
    if (e.type === "result" && !e.ok) failure = e.text || `${input.task.agent} stopped without a result`;
  }
  return failure === undefined
    ? ok(undefined)
    : err(new MetatorError("COMMAND_FAILED", `${input.hostName}: ${failure}`, { hint: input.hint }));
}
