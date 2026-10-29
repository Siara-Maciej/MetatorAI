import { stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { type CheckoutReader, err, MetatorError, ok, type Result } from "@metator/core";

/** Files of other checkouts on this machine (F7.3); a path may not leave its root. */
export class BunCheckoutReader implements CheckoutReader {
  async read(root: string, path: string): Promise<Result<string | undefined, MetatorError>> {
    const target = join(root, path);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) return err(MetatorError.usage(`${path} is outside ${root}`));
    const file = Bun.file(target);
    return ok((await file.exists()) ? await file.text() : undefined);
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }
}
