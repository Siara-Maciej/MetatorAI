/**
 * The files of a run a person may read, each a button that opens it read-only; the ones the
 * workflow expects and no stage wrote yet are listed dimmed.
 */
import { useState } from "react";
import { useDaemon, usePolled } from "../daemon.tsx";
import { sizeText } from "../model.ts";
import { ArtifactViewer } from "./artifact-viewer.tsx";

export function ArtifactList({
  runId,
  repo,
  bookkeeping = false,
}: {
  readonly runId: string;
  readonly repo: string | undefined;
  /** Also the run's own files (its record, its log, its questions). */
  readonly bookkeeping?: boolean;
}) {
  const { client } = useDaemon();
  const { data, error } = usePolled(
    `artifacts:${repo ?? ""}:${runId}`,
    () => client.artifacts(runId, repo),
    5000,
  );
  const [viewing, setViewing] = useState<string>();
  const list = (data ?? []).filter((a) => bookkeeping || !a.bookkeeping);
  return (
    <div className="artifact-list" data-testid="artifacts">
      {error && !data ? <div className="faint">The artifacts could not be read: {error}</div> : null}
      {data && list.length === 0 ? <div className="faint">No artifact yet.</div> : null}
      <ul>
        {list.map((a) => (
          <li key={a.name} className={a.expected ? "expected" : undefined}>
            {a.expected ? (
              <span
                className="faint mono"
                title={a.stage ? `the stage ${a.stage} writes it` : "not written yet"}
              >
                ○ {a.name}
              </span>
            ) : (
              <button type="button" className="ghost link mono" onClick={() => setViewing(a.name)}>
                {a.name}
              </button>
            )}
            <span className="faint">
              {a.expected
                ? ` not written yet${a.stage ? ` · ${a.stage}` : ""}`
                : ` ${a.kind} · ${sizeText(a.size)}`}
            </span>
          </li>
        ))}
      </ul>
      {viewing ? (
        <ArtifactViewer runId={runId} repo={repo} name={viewing} onClose={() => setViewing(undefined)} />
      ) : null}
    </div>
  );
}
