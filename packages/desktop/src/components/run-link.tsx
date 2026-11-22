/** A run named in a line of another thing (a task's run, a proposal's run): its short id and state, a link. */
import { useDaemon } from "../daemon.tsx";
import { routeHash, runStateOf, runTabFor, shortRunId } from "../model.ts";
import { Glyph, StateWord } from "./glyph.tsx";

export function RunLink({
  runId,
  repo,
  onOpen,
}: {
  readonly runId: string;
  readonly repo?: string | undefined;
  onOpen(runId: string): void;
}) {
  const { run: runOf, runs } = useDaemon();
  const run = runOf(runId, repo) ?? runs.find((r) => r.runId === runId);
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
