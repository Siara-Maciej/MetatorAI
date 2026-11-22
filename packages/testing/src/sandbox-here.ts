import { LINUX_SANDBOX_PROGRAMS, sandboxUnavailable } from "@metator/core";

/**
 * Why this machine cannot hold the sandbox host sessions start in (ADR-0104), or undefined when
 * it can: what `metator doctor` says (isolation). A test that needs a real sandbox is skipped,
 * and says why, where this is set.
 */
export function sandboxUnheldHere(): string | undefined {
  return sandboxUnavailable(
    process.platform,
    LINUX_SANDBOX_PROGRAMS.filter((program) => Bun.which(program) === null),
  );
}
