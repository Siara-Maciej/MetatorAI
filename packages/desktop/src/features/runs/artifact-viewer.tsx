/**
 * One file of a run, read-only: Markdown and text in a readable pane (an agent's words are never
 * turned into HTML; code blocks in mono), JSON pretty-printed, YAML as it is.
 *
 * The file is asked once (ADR-0113): the head reads only its kind, the body the text.
 */

import { MarkdownBlocks } from "../../shared/components/markdown-blocks.tsx";
import { useDaemon, usePolled, usePolledSelect } from "../../shared/daemon/daemon.tsx";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";

interface Of {
  readonly runId: string;
  readonly repo: string | undefined;
  readonly name: string;
}

export function ArtifactViewer({ runId, repo, name, onClose }: Of & { onClose(): void }) {
  return (
    <Modal label={`artifact ${name}`} className="dialog artifact-viewer" closeOnBackdrop onClose={onClose}>
      <div className="viewer-head">
        <h2 className="mono">{name}</h2>
        <ViewerKind runId={runId} repo={repo} name={name} />
        <span className="spacer" />
        <Button onClick={onClose}>Close</Button>
      </div>
      <ViewerBody runId={runId} repo={repo} name={name} />
    </Modal>
  );
}

const artifactKey = ({ runId, repo, name }: Of) => `artifact:${repo ?? ""}:${runId}:${name}`;

function ViewerKind(of: Of) {
  const { client } = useDaemon("client");
  const kind = usePolledSelect(
    artifactKey(of),
    () => client.artifact(of.runId, of.name, of.repo),
    0,
    (d) => d?.kind,
  );
  return <span className="faint">{kind ? `${kind} · read-only` : ""}</span>;
}

function ViewerBody(of: Of) {
  const { client } = useDaemon("client");
  const { data, error } = usePolled(artifactKey(of), () => client.artifact(of.runId, of.name, of.repo), 0);
  return (
    <>
      {error && !data ? <div className="banner">{error}</div> : null}
      {data ? (
        <div className="viewer-body" data-testid="artifact-text">
          <MarkdownBlocks kind={data.kind} text={data.text} />
          {data.truncated ? <p className="faint">The file is longer: this is its beginning.</p> : null}
        </div>
      ) : !error ? (
        <div className="faint">Reading {of.name}…</div>
      ) : null}
    </>
  );
}
