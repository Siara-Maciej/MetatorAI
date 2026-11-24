/** A run named in a line of another thing (a task's run, a proposal's run): its short id and state, a link. */

import { Glyph, StateWord } from "../../shared/components/glyph.tsx";
import { useRun } from "../../shared/daemon/daemon.tsx";
import { shortRunId } from "../../shared/model/format.ts";
import { routeHash } from "../../shared/model/route.ts";
import { runStateOf, runTabFor } from "../../shared/model/runs.ts";

export function RunLink({
  runId,
  repo,
  onOpen,
}: {
  readonly runId: string;
  readonly repo?: string | undefined;
  onOpen(runId: string): void;
}) {
  // This run only: a link draws again when its run changed, not when any run did.
  const exact = useRun(runId, repo);
  const anywhere = useRun(runId);
  const run = exact ?? anywhere;
  const state = run ? runStateOf(run) : undefined;
  return (
    <span className="run-link" data-testid={`run-link-${runId}`}>
      <a
        className="mono"
        href={routeHash({ screen: "run", runId, tab: run ? runTabFor(run) : "overview" })}
        title={run ? `${run.task}\n${runId}` : runId}
        onClick={(e) => {
          e.preventDefault();
          onOpen(runId);
        }}
      >
        {shortRunId(runId)}
      </a>
      {state ? (
        <>
          {" "}
          <Glyph kind="run" state={state} /> <StateWord kind="run" state={state} />
        </>
      ) : (
        <span className="faint"> not in the state</span>
      )}
    </span>
  );
}
