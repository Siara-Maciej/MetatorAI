/**
 * One file of a run, read-only: Markdown and text in a readable pane (an agent's words are never
 * turned into HTML; code blocks in mono), JSON pretty-printed, YAML as it is.
 */

import { MarkdownBlocks } from "../../shared/components/markdown-blocks.tsx";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";

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
  const { client } = useDaemon("client");
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
        <Button onClick={onClose}>Close</Button>
      </div>
      {error && !data ? <div className="banner">{error}</div> : null}
      {data ? (
        <div className="viewer-body" data-testid="artifact-text">
          <MarkdownBlocks kind={data.kind} text={data.text} />
          {data.truncated ? <p className="faint">The file is longer: this is its beginning.</p> : null}
        </div>
      ) : !error ? (
        <div className="faint">Reading {name}…</div>
      ) : null}
    </Modal>
  );
}
