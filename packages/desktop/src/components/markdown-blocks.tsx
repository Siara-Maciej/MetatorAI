/**
 * Markdown as a person reads it, without HTML made from an agent's words: headings, fenced code in
 * mono, the rest as written (`artifactBlocks`). The artifact viewer and the Backlog's analysis.
 */
import type { RunArtifactKind } from "../api.ts";
import { artifactBlocks } from "../model.ts";

export function MarkdownBlocks({
  text,
  kind = "markdown",
}: {
  readonly text: string;
  readonly kind?: RunArtifactKind;
}) {
  return (
    <>
      {artifactBlocks(kind, text).map((b, i) =>
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
    </>
  );
}
