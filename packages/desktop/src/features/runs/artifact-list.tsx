/**
 * The files of a run a person may read, each a button that opens it read-only; the ones the
 * workflow expects and no stage wrote yet are listed dimmed.
 *
 * The artifact opened is the Artifacts store's (ADR-0113); each row reads its own artifact.
 */

import type { RunArtifact } from "../../shared/api/api.ts";
import { useDaemon, usePolled, usePolledSelect } from "../../shared/daemon/daemon.tsx";
import { sizeText } from "../../shared/model/format.ts";
import { ScopeProvider, useScopedApi } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { ArtifactViewer } from "./artifact-viewer.tsx";
import { Artifacts, useArtifacts } from "./run-parts-state.ts";

interface Of {
  readonly runId: string;
  readonly repo: string | undefined;
}

export function ArtifactList({
  runId,
  repo,
  bookkeeping = false,
}: Of & {
  /** Also the run's own files (its record, its log, its questions). */
  readonly bookkeeping?: boolean;
}) {
  return (
    <ScopeProvider store={Artifacts} init={undefined}>
      <div className="artifact-list" data-testid="artifacts">
        <ArtifactsRead runId={runId} repo={repo} bookkeeping={bookkeeping} />
        <ArtifactRows runId={runId} repo={repo} bookkeeping={bookkeeping} />
        <Viewing runId={runId} repo={repo} />
      </div>
    </ScopeProvider>
  );
}

const artifactsKey = (runId: string, repo: string | undefined) => `artifacts:${repo ?? ""}:${runId}`;

/** The run's artifacts, or `select`'s part of them (undefined before the first answer). */
function useArtifactData<R>({ runId, repo }: Of, select: (all: readonly RunArtifact[] | undefined) => R): R {
  const { client } = useDaemon("client");
  return usePolledSelect(artifactsKey(runId, repo), () => client.artifacts(runId, repo), 5000, select);
}

const shown = (all: readonly RunArtifact[] | undefined, bookkeeping: boolean) =>
  (all ?? []).filter((a) => bookkeeping || !a.bookkeeping);

/** A failed read with nothing to show, or nothing written yet. */
function ArtifactsRead({ runId, repo, bookkeeping }: Of & { readonly bookkeeping: boolean }) {
  const { client } = useDaemon("client");
  const { data, error } = usePolled(artifactsKey(runId, repo), () => client.artifacts(runId, repo), 5000);
  const empty = data !== undefined && shown(data, bookkeeping).length === 0;
  return (
    <>
      {error && !data ? <div className="faint">The artifacts could not be read: {error}</div> : null}
      {empty ? <div className="faint">No artifact yet.</div> : null}
    </>
  );
}

function ArtifactRows({ runId, repo, bookkeeping }: Of & { readonly bookkeeping: boolean }) {
  const names = useArtifactData({ runId, repo }, (all) => shown(all, bookkeeping).map((a) => a.name));
  return (
    <ul>
      {names.map((name) => (
        <ArtifactRow key={name} runId={runId} repo={repo} name={name} />
      ))}
    </ul>
  );
}

function ArtifactRow({ runId, repo, name }: Of & { readonly name: string }) {
  const a = useArtifactData({ runId, repo }, (all) => all?.find((x) => x.name === name));
  const api = useScopedApi(Artifacts);
  if (!a) return null;
  return (
    <li className={a.expected ? "expected" : undefined}>
      {a.expected ? (
        <span className="faint mono" title={a.stage ? `the stage ${a.stage} writes it` : "not written yet"}>
          ○ {a.name}
        </span>
      ) : (
        <Button variant="ghost" className="link mono" onClick={() => api.getState().view(a.name)}>
          {a.name}
        </Button>
      )}
      <span className="faint">
        {a.expected
          ? ` not written yet${a.stage ? ` · ${a.stage}` : ""}`
          : ` ${a.kind} · ${sizeText(a.size)}`}
      </span>
    </li>
  );
}

function Viewing({ runId, repo }: Of) {
  const viewing = useArtifacts((s) => s.viewing);
  const view = useArtifacts((s) => s.view);
  return viewing ? (
    <ArtifactViewer runId={runId} repo={repo} name={viewing} onClose={() => view(undefined)} />
  ) : null;
}
