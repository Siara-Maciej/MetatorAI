/**
 * "Debug changes (N)" (round 13): the edits not meant for a commit that MetatorAI recorded
 * (console.log, temporary flags). The entry shows while the daemon's state counts some; a click
 * lists them (files, what for, when) from `GET /scratch`, with "Remove debug changes" for all
 * and Remove for one (`POST /scratch/drop`). A record leaves only when it was removed, when the
 * person forgets it (Forget on a `changed` one, `POST /scratch/forget`), or when no file holds
 * its lines any more, and each of these is said in a line: nothing is forced, nothing goes silently.
 *
 * What it keeps is the DebugChanges store (`debug-changes-state.ts`, ADR-0113); each part of the
 * list reads only what it shows.
 */

import { useDaemon, useDaemonStore, usePolled, usePolledSelect } from "../../shared/daemon/daemon.tsx";
import { clock } from "../../shared/model/format.ts";
import {
  changedWhy,
  goneText,
  type ScratchItem,
  scratchGone,
  scratchItems,
  scratchLine,
} from "../../shared/model/stage1.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { Notice } from "../../ui/notice.tsx";
import {
  DebugChanges as DebugStore,
  scratchKey,
  useDebugChanges,
  useDebugChangesApi,
} from "./debug-changes-state.ts";

type Repos = readonly (string | undefined)[];

export function DebugChanges({
  repos,
}: {
  /** Only these repositories' (a task's); every repository's when left out. */
  readonly repos?: Repos | undefined;
}) {
  const daemon = useDaemonStore();
  return (
    <ScopeProvider store={DebugStore} init={{ daemon }}>
      <DebugEntry repos={repos} />
    </ScopeProvider>
  );
}

function DebugEntry({ repos }: { readonly repos: Repos | undefined }) {
  const d = useDaemon("scratchCount", "scratchRepos");
  const count = d.scratchCount(repos);
  const open = useDebugChanges((s) => s.open);
  const said = useDebugChanges((s) => s.said);
  const openList = useDebugChanges((s) => s.openList);
  const dismiss = useDebugChanges((s) => s.dismiss);
  if (count === 0 && !open && !said) return null;
  return (
    <>
      {count > 0 ? (
        <Button
          className="debug-changes"
          data-testid="debug-changes"
          title="Edits not meant for a commit that MetatorAI recorded: see them, remove them"
          onClick={openList}
        >
          Debug changes ({count})
        </Button>
      ) : null}
      {said && !open ? (
        <span className={said.ok ? "faint" : "amber"} role="status" data-testid="debug-changes-said">
          {said.text}{" "}
          <Button variant="ghost" aria-label="dismiss" onClick={dismiss}>
            ✕
          </Button>
        </span>
      ) : null}
      {open ? <DebugChangesList repos={d.scratchRepos(repos)} /> : null}
    </>
  );
}

const NO_ITEMS: readonly ScratchItem[] = [];

/** The debug changes of `repos`, or `select`'s part of them (undefined before the first answer). */
function useScratch<R>(repos: Repos, select: (items: readonly ScratchItem[] | undefined) => R): R {
  const fn = useScratchRead(repos);
  return usePolledSelect(scratchKey(repos), fn, 0, select);
}

/** The read of the list: a record the answer says is gone is kept in the store's `gone`. */
function useScratchRead(repos: Repos) {
  const { client } = useDaemon("client");
  const api = useDebugChangesApi();
  return async () => {
    const all = await Promise.all(
      repos.map(async (repo) => {
        const r = await client.scratch(repo);
        return {
          ok: r.ok,
          error: r.error,
          items: r.ok ? scratchItems(r.data, repo) : [],
          gone: r.ok ? scratchGone(r.data) : [],
        };
      }),
    );
    const left = all.flatMap((x) => x.gone);
    if (left.length > 0) api.getState().noteGone(goneText(left));
    const failed = all.find((x) => !x.ok);
    return failed && all.every((x) => x.items.length === 0)
      ? { ok: false, ...(failed.error ? { error: failed.error } : {}) }
      : { ok: true, data: all.flatMap((x) => x.items) };
  };
}

function DebugChangesList({ repos }: { readonly repos: Repos }) {
  const closeList = useDebugChanges((s) => s.closeList);
  return (
    <Modal
      label="Debug changes"
      className="dialog debug-changes-dialog"
      closeOnBackdrop
      onClose={() => closeList()}
    >
      <h2>Debug changes</h2>
      <p className="muted">
        Edits made on request that are not meant for a commit. Removing one takes its lines back out of your
        files; a commit that holds one is stopped until you say so.
      </p>
      <ListError repos={repos} />
      <ListNotice />
      <ListSaid />
      <ListGone />
      <ul className="scratch-list" data-testid="scratch-list">
        <Items repos={repos} />
      </ul>
      <div className="actions">
        <RemoveAll repos={repos} />
        <Button onClick={() => closeList()}>Close</Button>
      </div>
    </Modal>
  );
}

function ListError({ repos }: { readonly repos: Repos }) {
  const fn = useScratchRead(repos);
  const list = usePolled(scratchKey(repos), fn, 0);
  return list.error && !list.data ? <div className="banner">{list.error}</div> : null;
}

function ListNotice() {
  const notice = useDebugChanges((s) => s.notice);
  const closeNotice = useDebugChanges((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
}

function ListSaid() {
  const said = useDebugChanges((s) => s.listSaid);
  return said ? (
    <div
      className={said.ok ? "notice info" : "notice error"}
      role="status"
      data-testid="debug-changes-result"
    >
      {said.text}
    </div>
  ) : null;
}

function ListGone() {
  const gone = useDebugChanges((s) => s.gone);
  return gone ? (
    <div className="notice info" role="status" data-testid="debug-changes-gone">
      {gone}
    </div>
  ) : null;
}

function Items({ repos }: { readonly repos: Repos }) {
  const items = useScratch(repos, (all) => all ?? NO_ITEMS);
  const read = useScratch(repos, (all) => all !== undefined);
  const busy = useDebugChanges((s) => s.busy);
  const api = useDebugChangesApi();
  return (
    <>
      {items.map((i) => (
        <li key={`${i.repo ?? ""}/${i.id}`} data-testid={`scratch-${i.id}`} data-state={i.state}>
          <span className="what">
            <span className="mono">{scratchLine(i)}</span>
            <span className="faint">
              {" "}
              {[i.repo, i.at ? clock(i.at) : undefined].filter(Boolean).join(" · ")}
            </span>
            {i.state === "changed" ? (
              <span className="amber changed" data-testid={`scratch-changed-${i.id}`}>
                Cannot be removed: {changedWhy(i.why)}. Take its lines out by hand, or forget it.
              </span>
            ) : null}
          </span>
          {i.state === "changed" ? (
            <Button
              disabled={busy}
              title="Dismiss this record; your files are not touched"
              onClick={() => void api.getState().forget(repos, i)}
            >
              Forget
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void api.getState().drop(repos, items, i)}>
              Remove
            </Button>
          )}
        </li>
      ))}
      {read && items.length === 0 ? <li className="faint">No debug change is left.</li> : null}
    </>
  );
}

function RemoveAll({ repos }: { readonly repos: Repos }) {
  const items = useScratch(repos, (all) => all ?? NO_ITEMS);
  const busy = useDebugChanges((s) => s.busy);
  const api = useDebugChangesApi();
  const removable = items.filter((i) => i.state === "removable").length;
  return (
    <Button
      variant="primary"
      disabled={busy || removable === 0}
      data-testid="remove-debug-changes"
      onClick={() => void api.getState().drop(repos, items)}
    >
      Remove debug changes
    </Button>
  );
}
