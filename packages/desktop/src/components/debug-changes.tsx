/**
 * "Debug changes (N)" (round 13): the edits not meant for a commit that MetatorAI recorded
 * (console.log, temporary flags). The entry shows while the daemon's state counts some; a click
 * lists them (files, what for, when) from `GET /scratch`, with "Remove debug changes" for all
 * and Remove for one (`POST /scratch/drop`). What was removed, and what could not be because its
 * patch no longer applies, is said in a line; nothing is forced.
 */
import { useState } from "react";
import { useDaemon, usePolled } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { clock } from "../model.ts";
import { dropText, type ScratchDropped, type ScratchItem, scratchItems, scratchLine } from "../stage1.ts";
import { Notice } from "./common.tsx";
import { Modal } from "./modal.tsx";

export function DebugChanges({
  repos,
}: {
  /** Only these repositories' (a task's); every repository's when left out. */
  readonly repos?: readonly (string | undefined)[] | undefined;
}) {
  const d = useDaemon();
  const count = d.scratchCount(repos);
  const [open, setOpen] = useState(false);
  // What the last removal did stays in the entry's place when nothing is left to list.
  const [said, setSaid] = useState<{ text: string; ok: boolean }>();
  if (count === 0 && !open && !said) return null;
  return (
    <>
      {count > 0 ? (
        <button
          type="button"
          className="debug-changes"
          data-testid="debug-changes"
          title="Edits not meant for a commit that MetatorAI recorded: see them, remove them"
          onClick={() => setOpen(true)}
        >
          Debug changes ({count})
        </button>
      ) : null}
      {said && !open ? (
        <span className={said.ok ? "faint" : "amber"} role="status" data-testid="debug-changes-said">
          {said.text}{" "}
          <button type="button" className="ghost" aria-label="dismiss" onClick={() => setSaid(undefined)}>
            ✕
          </button>
        </span>
      ) : null}
      {open ? (
        <DebugChangesList
          repos={d.scratchRepos(repos)}
          onClose={(result) => {
            setOpen(false);
            if (result) setSaid(result);
          }}
        />
      ) : null}
    </>
  );
}

function DebugChangesList({
  repos,
  onClose,
}: {
  readonly repos: readonly (string | undefined)[];
  onClose(said?: { text: string; ok: boolean }): void;
}) {
  const { client } = useDaemon();
  const action = useAction();
  const list = usePolled(
    `scratch:${repos.map((r) => r ?? "").join(",")}`,
    async () => {
      const all = await Promise.all(
        repos.map(async (repo) => {
          const r = await client.scratch(repo);
          return { ok: r.ok, error: r.error, items: r.ok ? scratchItems(r.data, repo) : [] };
        }),
      );
      const failed = all.find((x) => !x.ok);
      return failed && all.every((x) => x.items.length === 0)
        ? { ok: false, ...(failed.error ? { error: failed.error } : {}) }
        : { ok: true, data: all.flatMap((x) => x.items) };
    },
    0,
  );
  const [said, setSaid] = useState<{ text: string; ok: boolean }>();
  const items = list.data ?? [];
  /** Removes one debug change, or every one of the repositories shown. */
  const drop = async (only?: ScratchItem) => {
    const results: ScratchDropped[] = [];
    const targets = only ? [only.repo] : repos;
    const ok = await action.run(
      async (by) => {
        let last: Awaited<ReturnType<typeof client.dropScratch>> = { ok: true };
        for (const repo of targets) {
          last = await client.dropScratch({ ...(only ? { ids: [only.id] } : {}), by }, repo);
          if (!last.ok) return last;
          if (last.data) results.push(last.data);
        }
        return last;
      },
      { who: true, refused: "Nothing was removed" },
    );
    if (!ok) return;
    const result = dropText(results);
    await list.reload();
    // Everything went: the list closes and the line stays where the entry was.
    if (!only && result.ok) onClose(result);
    else setSaid(result);
  };
  return (
    <Modal
      label="Debug changes"
      className="dialog debug-changes-dialog"
      closeOnBackdrop
      onClose={() => onClose(said)}
    >
      <h2>Debug changes</h2>
      <p className="muted">
        Edits made on request that are not meant for a commit. Removing one takes its lines back out of your
        files; a commit that holds one is stopped until you say so.
      </p>
      {list.error && !list.data ? <div className="banner">{list.error}</div> : null}
      <Notice {...action.notice} />
      {said ? (
        <div
          className={said.ok ? "notice info" : "notice error"}
          role="status"
          data-testid="debug-changes-result"
        >
          {said.text}
        </div>
      ) : null}
      <ul className="scratch-list" data-testid="scratch-list">
        {items.map((i) => (
          <li key={`${i.repo ?? ""}/${i.id}`} data-testid={`scratch-${i.id}`}>
            <span className="what">
              <span className="mono">{scratchLine(i)}</span>
              <span className="faint">
                {" "}
                {[i.repo, i.at ? clock(i.at) : undefined].filter(Boolean).join(" · ")}
              </span>
            </span>
            <button type="button" disabled={action.busy} onClick={() => void drop(i)}>
              Remove
            </button>
          </li>
        ))}
        {list.data && items.length === 0 ? <li className="faint">No debug change is left.</li> : null}
      </ul>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={action.busy || items.length === 0}
          data-testid="remove-debug-changes"
          onClick={() => void drop()}
        >
          Remove debug changes
        </button>
        <button type="button" onClick={() => onClose(said)}>
          Close
        </button>
      </div>
    </Modal>
  );
}
