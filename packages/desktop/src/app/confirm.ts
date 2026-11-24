/**
 * The confirmation of an answer, read back from the daemon (pure but for the calls it is given):
 * the run is looked at a few times while a drive moves it on. Only the latest answer speaks: a
 * confirmation still looking when the next answer is given says nothing, so a notice never names
 * an answer given before the one just sent.
 */
import { answeredText } from "../shared/model/needs.ts";
import type { Run } from "../shared/model/runs.ts";

export interface Confirmer {
  confirm(
    choices: readonly string[],
    item: { readonly runId: string; readonly repo?: string | undefined; readonly stage: string },
  ): Promise<void>;
}

export function createConfirmer(deps: {
  /** The run as the daemon has it now, if it lists it. */
  readonly read: (runId: string, repo: string | undefined) => Promise<Run | undefined>;
  readonly say: (text: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly tries?: number;
}): Confirmer {
  let latest = 0;
  return {
    async confirm(choices, item) {
      const mine = ++latest;
      let after: Run | undefined;
      for (let i = 0; i < (deps.tries ?? 6); i++) {
        after = await deps.read(item.runId, item.repo);
        if (mine !== latest) return;
        if (after?.status !== "active" || after.stage !== item.stage) break;
        await deps.sleep(500);
        if (mine !== latest) return;
      }
      if (mine === latest) deps.say(answeredText(choices, after, item.stage));
    },
  };
}
