/**
 * A run's artifacts, readable where the decision is made (F9): each name is a button, and the one
 * chosen is shown below as plain text (Markdown and JSON as they are written). The content comes
 * from `GET /runs/:id/artifact`; the app never reads a file itself.
 */
import { useState } from "react";
import { useDaemon } from "../daemon.tsx";
import { artifactText } from "../model.ts";

export function Artifacts({
  runId,
  repo,
  names,
  missing = [],
}: {
  readonly runId: string;
  readonly repo?: string | undefined;
  /** Artifacts that exist: each can be opened. */
  readonly names: readonly string[];
  /** Artifacts a stage will write later: listed, not opened. */
  readonly missing?: readonly string[];
}) {
  const { client } = useDaemon();
  const [open, setOpen] = useState<{ name: string; text: string; note?: string | undefined }>();
  const [busy, setBusy] = useState<string>();
  const show = async (name: string) => {
    if (open?.name === name) {
      setOpen(undefined);
      return;
    }
    setBusy(name);
    const r = await client.artifact(runId, name, repo);
    setBusy(undefined);
    setOpen(
      r.ok && r.data
        ? {
            name,
            text: artifactText(name, r.data.content),
            note: r.data.truncated ? "The file is longer: this is its beginning." : undefined,
          }
        : { name, text: "", note: r.error?.message ?? `${name} could not be read` },
    );
  };
  return (
    <div className="artifacts">
      <div className="names">
        {names.map((n) => (
          <button
            type="button"
            key={n}
            className="ghost mono artifact"
            aria-expanded={open?.name === n}
            disabled={busy === n}
            title={`read ${n}`}
            onClick={() => void show(n)}
          >
            {n}
          </button>
        ))}
        {missing.map((n) => (
          <span key={n} className="dim mono" title="not written yet">
            ○ {n}
          </span>
        ))}
      </div>
      {open ? (
        <section className="artifact-view" aria-label={`artifact ${open.name}`}>
          <div className="head">
            <span className="mono">{open.name}</span>
            <span className="spacer" />
            <button
              type="button"
              className="ghost"
              aria-label="close the artifact"
              onClick={() => setOpen(undefined)}
            >
              ✕
            </button>
          </div>
          {open.note ? <div className="dim">{open.note}</div> : null}
          {open.text ? <pre className="mono">{open.text}</pre> : null}
        </section>
      ) : null}
    </div>
  );
}
