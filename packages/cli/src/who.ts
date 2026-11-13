import { err, MetatorError, ok, type Result } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Who acts, when the command was not told: `--by`, else `$METATOR_USER`, else the name git signs
 * this repository's commits with, else the login name (`$USER`, `$USERNAME`). One rule for every
 * command. No name anywhere is a usage error that says where to set one:
 * nothing is ever recorded under a made-up name.
 */
export function whoFrom(
  given: string | undefined,
  env: Env,
  gitName: string | undefined,
): Result<string, MetatorError> {
  const name = [given, env.METATOR_USER, gitName, env.USER, env.USERNAME]
    .map((n) => n?.trim())
    .find((n) => n);
  if (name) return ok(name);
  return err(
    MetatorError.usage(
      "say who you are: --by <name>",
      'Without --by the name comes from $METATOR_USER, else from `git config user.name`, else from your login name; set one (`git config user.name "Your Name"`) or give --by.',
    ),
  );
}

/** `whoFrom` with the process's environment and the repository's `git config user.name`. */
export async function who(
  c: MetatorContainer,
  given?: string | undefined,
  env: Env = process.env,
): Promise<Result<string, MetatorError>> {
  if (given?.trim() || env.METATOR_USER?.trim()) return whoFrom(given, env, undefined);
  const git = await c
    .resolve("processRunner")
    .run({ argv: ["git", "config", "user.name"], cwd: c.resolve("root") });
  return whoFrom(given, env, git.exitCode === 0 ? git.stdout : undefined);
}

/** Runs a command's work as the person it names; a usage error when nobody can be named. */
export async function asPerson<O>(
  c: MetatorContainer,
  given: string | undefined,
  work: (by: string) => Promise<O> | O,
): Promise<O | { result: Result<never, MetatorError> }> {
  const by = await who(c, given);
  return by.isErr() ? { result: err(by.error) } : work(by.value);
}
