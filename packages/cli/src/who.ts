import { err, MetatorError, ok, type Result } from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Whom a name may come from: anyone who acts may be their login name; a decision (an approval,
 * sending or resolving on a code host) is recorded only under a name someone set: `--by`,
 * `$METATOR_USER` or git's `user.name`.
 */
export type Speaker = "person" | "decision";

/**
 * Who acts, when the command was not told: `--by`, else `$METATOR_USER`, else the name git signs
 * this repository's commits with, else (not for a decision) the login name (`$USER`, `$USERNAME`).
 * One rule for every command. No name anywhere, or an empty `--by`, is a usage error that says
 * where to set one: nothing is ever recorded under a made-up name. This is only who speaks: the
 * command a person ran is still the whole decision.
 */
export function whoFrom(
  given: string | undefined,
  env: Env,
  gitName: string | undefined,
  speaker: Speaker = "person",
): Result<string, MetatorError> {
  const login = speaker === "person" ? [env.USER, env.USERNAME] : [];
  // A name given and left empty is nobody: it is refused, never filled in from somewhere else.
  const name =
    given === undefined
      ? [env.METATOR_USER, gitName, ...login].map((n) => n?.trim()).find((n) => n)
      : given.trim();
  if (name) return ok(name);
  return err(
    MetatorError.usage(
      "say who you are: --by <name>",
      speaker === "person"
        ? 'Without --by the name comes from $METATOR_USER, else from `git config user.name`, else from your login name; set one (`git config user.name "Your Name"`) or give --by.'
        : 'Without --by the name comes from $METATOR_USER, else from `git config user.name`; set one (`git config user.name "Your Name"`) or give --by.',
    ),
  );
}

/** `whoFrom` with the process's environment and the repository's `git config user.name`. */
export async function who(
  c: MetatorContainer,
  given?: string | undefined,
  env: Env = process.env,
  speaker: Speaker = "person",
): Promise<Result<string, MetatorError>> {
  if (given !== undefined || env.METATOR_USER?.trim()) return whoFrom(given, env, undefined, speaker);
  const git = await c
    .resolve("processRunner")
    .run({ argv: ["git", "config", "user.name"], cwd: c.resolve("root") });
  return whoFrom(given, env, git.exitCode === 0 ? git.stdout : undefined, speaker);
}

/** Runs a command's work as the person it names; a usage error when nobody can be named. */
export async function asPerson<O>(
  c: MetatorContainer,
  given: string | undefined,
  work: (by: string) => Promise<O> | O,
  speaker: Speaker = "person",
): Promise<O | { result: Result<never, MetatorError> }> {
  const by = await who(c, given, process.env, speaker);
  return by.isErr() ? { result: err(by.error) } : work(by.value);
}
