import type { MetatorError } from "../domain/errors.ts";
import { EMPTY_LAYOUT, type Layout, LayoutDocument } from "../domain/layout.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { FileSystem } from "../ports/index.ts";

export const LAYOUT_FILE = ".metator/layout.json";

/** The layout on disk (R1): the daemon's only memory of its workspaces and panes across restarts. */
export class LayoutStore {
  constructor(
    private readonly fs: FileSystem,
    private readonly file: string = LAYOUT_FILE,
  ) {}

  async load(): Promise<Result<Layout, MetatorError>> {
    if (!(await this.fs.exists(this.file))) return ok(EMPTY_LAYOUT);
    const text = await this.fs.read(this.file);
    if (text.isErr()) return err(text.error);
    const raw = parseJsonDocument(text.value, this.file);
    if (raw.isErr()) return err(raw.error);
    return LayoutDocument.parse(raw.value, this.file);
  }

  save(layout: Layout): Promise<Result<void, MetatorError>> {
    return this.fs.write(this.file, serializeJsonDocument(LayoutDocument.stamp(layout)));
  }

  /** Reads, changes, writes: `change` returns the new layout and what the caller wants back. */
  async update<T>(
    change: (layout: Layout) => Result<{ readonly layout: Layout; readonly value: T }, MetatorError>,
  ): Promise<Result<T, MetatorError>> {
    const current = await this.load();
    if (current.isErr()) return err(current.error);
    const changed = change(current.value);
    if (changed.isErr()) return err(changed.error);
    const saved = await this.save(changed.value.layout);
    if (saved.isErr()) return err(saved.error);
    return ok(changed.value.value);
  }
}
