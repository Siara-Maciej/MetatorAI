import { err, MetatorError, ok, type Result } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";

/**
 * Who acts, when the command was not told: `--by`, else `$METATOR_USER`, else the name git signs
 * this repository's commits with. No name anywhere is a usage error that says where to set one.
 */
export function whoFrom(
  given: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  gitName: string | undefined,
): Result<string, MetatorError> {
  const name = [given, env.METATOR_USER, gitName].map((n) => n?.trim()).find((n) => n);
  if (name) return ok(name);
  return err(
    MetatorError.usage(
      "say who you are: --by <name>",
      'Without --by the name comes from $METATOR_USER, else from `git config user.name`; set one (`git config user.name "Your Name"`) or give --by.',
    ),
  );
}

/** What a `--by` that may be left out says of its default, in the option's description. */
export const BY_DEFAULT = " (default: $METATOR_USER, else git's user.name)";

/** `whoFrom` with this process's environment and the repository's `git config user.name`. */
export async function who(
  c: MetatorContainer,
  given: string | undefined,
): Promise<Result<string, MetatorError>> {
  if (given?.trim() || process.env.METATOR_USER?.trim()) return whoFrom(given, process.env, undefined);
  const git = await c
    .resolve("processRunner")
    .run({ argv: ["git", "config", "user.name"], cwd: c.resolve("root") });
  return whoFrom(given, process.env, git.exitCode === 0 ? git.stdout : undefined);
}
