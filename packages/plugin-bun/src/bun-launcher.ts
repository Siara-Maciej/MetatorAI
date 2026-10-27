import { err, type Launcher, MetatorError, ok, type Result } from "@metator/core";

/** Launcher on Bun.spawn: attached programs share this terminal; detached ones get their own life. */
export class BunLauncher implements Launcher {
  async attached(argv: readonly string[], cwd: string): Promise<Result<number, MetatorError>> {
    try {
      const proc = Bun.spawn([...argv], { cwd, stdio: ["inherit", "inherit", "inherit"] });
      return ok(await proc.exited);
    } catch (e) {
      return err(new MetatorError("COMMAND_FAILED", `cannot run ${argv[0]}: ${(e as Error).message}`));
    }
  }

  async detached(argv: readonly string[], cwd: string): Promise<Result<void, MetatorError>> {
    try {
      const proc = Bun.spawn([...argv], { cwd, stdio: ["ignore", "ignore", "ignore"], detached: true });
      proc.unref();
      return ok(undefined);
    } catch (e) {
      return err(new MetatorError("COMMAND_FAILED", `cannot start ${argv[0]}: ${(e as Error).message}`));
    }
  }

  available(commands: readonly string[]): readonly string[] {
    return commands.filter((c) => Bun.which(c) !== null);
  }
}
