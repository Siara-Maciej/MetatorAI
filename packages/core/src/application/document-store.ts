import { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import type { VersionedDocument } from "../domain/versioned.ts";
import type { FileSystem } from "../ports/index.ts";
import { loadDocument, writeDocument } from "./document-io.ts";

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
    const value = await loadDocument(this.fs, file, this.doc, "yaml");
    if (value.isOk() && value.value.id !== id)
      return err(new MetatorError("INVALID_CONFIG", `${file}: its id is ${value.value.id}, not ${id}`));
    return value;
  }

  async save(value: T): Promise<Result<void, MetatorError>> {
    return writeDocument(this.fs, this.file(value.id), this.doc, value, "yaml", this.text.comment);
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
