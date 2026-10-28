import { CONFIG_FILES, MetatorConfigDocument } from "../domain/config.ts";
import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  parseJsonDocument,
  parseYamlDocument,
  renderYamlDocument,
  serializeJsonDocument,
  updateYamlFields,
} from "../domain/versioned.ts";
import type { FileSystem } from "../ports/index.ts";

/**
 * Saves the person's editor in metator.config (`metator ui`, ADR-0054). A YAML file keeps its
 * comments; the file becomes v3, which every v2 file already is.
 */
export class SetEditor {
  constructor(private readonly fs: FileSystem) {}

  async execute(input: {
    readonly editor: string;
  }): Promise<Result<{ readonly file: string }, MetatorError>> {
    let file: string | undefined;
    for (const f of CONFIG_FILES) if (await this.fs.exists(f)) file = file ?? f;
    if (!file) {
      const created = "metator.config.yml";
      const text = renderYamlDocument(
        {
          kind: MetatorConfigDocument.kind,
          schemaVersion: MetatorConfigDocument.current,
          editor: input.editor,
        },
        "Written by `metator ui`; every other setting keeps its default.",
      );
      return (await this.fs.write(created, text)).map(() => ({ file: created }));
    }
    const text = await this.fs.read(file);
    if (text.isErr()) return err(text.error);
    const current = file.endsWith(".json")
      ? parseJsonDocument(text.value, file)
      : parseYamlDocument(text.value, file);
    if (current.isErr()) return err(current.error);
    const valid = MetatorConfigDocument.parse(current.value, file);
    if (valid.isErr()) return err(valid.error);
    const next = file.endsWith(".json")
      ? serializeJsonDocument({
          ...(current.value as object),
          schemaVersion: MetatorConfigDocument.current,
          editor: input.editor,
        })
      : updateYamlFields(text.value, { schemaVersion: MetatorConfigDocument.current, editor: input.editor });
    const saved = await this.fs.write(file, next);
    if (saved.isErr()) return err(saved.error);
    return ok({ file });
  }
}
