/**
 * One file of a run, read-only: Markdown and text in a readable pane (an agent's words are never
 * turned into HTML; code blocks in mono), JSON pretty-printed, YAML as it is.
 */
import { useDaemon, usePolled } from "../daemon.tsx";
import { artifactBlocks } from "../model.ts";
import { Modal } from "./modal.tsx";

export function ArtifactViewer({
  runId,
  repo,
  name,
  onClose,
}: {
  readonly runId: string;
  readonly repo: string | undefined;
  readonly name: string;
  onClose(): void;
}) {
  const { client } = useDaemon();
  const { data, error } = usePolled(
    `artifact:${repo ?? ""}:${runId}:${name}`,
    () => client.artifact(runId, name, repo),
    0,
  );
  return (
    <Modal label={`artifact ${name}`} className="dialog artifact-viewer" closeOnBackdrop onClose={onClose}>
      <div className="viewer-head">
        <h2 className="mono">{name}</h2>
        <span className="faint">{data ? `${data.kind} · read-only` : ""}</span>
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {error && !data ? <div className="banner">{error}</div> : null}
      {data ? (
        <div className="viewer-body" data-testid="artifact-text">
          {artifactBlocks(data.kind, data.text).map((b, i) =>
            b.kind === "heading" ? (
              <h3 key={String(i)}>{b.text}</h3>
            ) : b.kind === "code" ? (
              <pre key={String(i)} className="mono">
                {b.text}
              </pre>
            ) : (
              <p key={String(i)} className="prose">
                {b.text}
              </p>
            ),
          )}
          {data.truncated ? <p className="faint">The file is longer: this is its beginning.</p> : null}
        </div>
      ) : !error ? (
        <div className="faint">Reading {name}…</div>
      ) : null}
    </Modal>
  );
}
