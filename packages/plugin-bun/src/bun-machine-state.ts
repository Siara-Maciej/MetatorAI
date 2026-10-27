import { existsSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, type MachineState, MetatorError, ok, type Result } from "@metator/core";

/**
 * MachineState in a directory of the user's (G1, ADR-0056): `$METATOR_STATE_DIR`, else
 * `$XDG_STATE_HOME/metator`, else `~/.local/state/metator`; the runtime picks it. A write goes to
 * a temporary file first and is renamed into place, so a reader never sees half a document.
 */
export class BunMachineState implements MachineState {
  constructor(private readonly dir: string) {}

  async read(name: string): Promise<Result<string | undefined, MetatorError>> {
    const file = Bun.file(join(this.dir, name));
    try {
      return ok((await file.exists()) ? await file.text() : undefined);
    } catch (e) {
      return err(
        new MetatorError("COMMAND_FAILED", `cannot read ${join(this.dir, name)}: ${(e as Error).message}`),
      );
    }
  }

  async write(name: string, content: string): Promise<Result<void, MetatorError>> {
    const target = join(this.dir, name);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, content);
      await rename(tmp, target);
      return ok(undefined);
    } catch (e) {
      return err(new MetatorError("COMMAND_FAILED", `cannot write ${target}: ${(e as Error).message}`));
    }
  }

  async dirExists(path: string): Promise<boolean> {
    return existsSync(path) && statSync(path).isDirectory();
  }
}
