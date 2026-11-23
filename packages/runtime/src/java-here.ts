import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JvmBuildTool, ProcessRunner } from "@metator/core";

/**
 * What only this machine says about a Java repository (round 22, `metator doctor`): the JDK's
 * `java -version`, and whether the build tool's local dependency cache is here.
 */

/** What `java -version` printed (it prints to stderr), or undefined when no JDK answered. */
export async function javaVersionOutput(runner: ProcessRunner, cwd: string): Promise<string | undefined> {
  const r = await runner.run({ argv: ["java", "-version"], cwd }, { timeoutMs: 15_000 });
  if (r.exitCode !== 0) return undefined;
  const said = `${r.stderr}\n${r.stdout}`.trim();
  return said === "" ? undefined : said;
}

/** Whether the tool's local cache is here: Maven's `~/.m2/repository`, Gradle's `$GRADLE_USER_HOME/caches`. */
export function buildCacheHere(
  tool: JvmBuildTool,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const home = env.HOME ?? homedir();
  return tool === "maven"
    ? existsSync(join(home, ".m2", "repository"))
    : existsSync(join(env.GRADLE_USER_HOME ?? join(home, ".gradle"), "caches"));
}
