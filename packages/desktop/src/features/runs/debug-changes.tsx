/**
 * "Debug changes (N)" (round 13): the edits not meant for a commit that MetatorAI recorded
 * (console.log, temporary flags). The entry shows while the daemon's state counts some; a click
 * lists them (files, what for, when) from `GET /scratch`, with "Remove debug changes" for all
 * and Remove for one (`POST /scratch/drop`). A record leaves only when it was removed, when the
 * person forgets it (Forget on a `changed` one, `POST /scratch/forget`), or when no file holds
 * its lines any more, and each of these is said in a line: nothing is forced, nothing goes silently.
 */

import { useState } from "react";
import { useDaemon, usePolled } from "../../shared/daemon/daemon.tsx";
import { useAction } from "../../shared/hooks.ts";
import { clock } from "../../shared/model/format.ts";
import {
  changedWhy,
  dropText,
  forgetText,
  goneText,
  type ScratchDropped,
  type ScratchItem,
  scratchGone,
  scratchItems,
  scratchLine,
} from "../../shared/model/stage1.ts";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { Notice } from "../../ui/notice.tsx";

export function DebugChanges({
  repos,
}: {
  /** Only these repositories' (a task's); every repository's when left out. */
  readonly repos?: readonly (string | undefined)[] | undefined;
}) {
  const d = useDaemon("scratchCount", "scratchRepos");
  const count = d.scratchCount(repos);
  const [open, setOpen] = useState(false);
  // What the last removal did stays in the entry's place when nothing is left to list.
  const [said, setSaid] = useState<{ text: string; ok: boolean }>();
  if (count === 0 && !open && !said) return null;
  return (
    <>
      {count > 0 ? (
        <Button
          className="debug-changes"
          data-testid="debug-changes"
          title="Edits not meant for a commit that MetatorAI recorded: see them, remove them"
          onClick={() => setOpen(true)}
        >
          Debug changes ({count})
        </Button>
      ) : null}
      {said && !open ? (
        <span className={said.ok ? "faint" : "amber"} role="status" data-testid="debug-changes-said">
          {said.text}{" "}
          <Button variant="ghost" aria-label="dismiss" onClick={() => setSaid(undefined)}>
            ✕
          </Button>
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
  const { client } = useDaemon("client");
  const action = useAction();
  // Records the daemon says are gone (no file holds them any more): said once, by the answer
  // that removed them, so they are kept here while the list is open.
  const [gone, setGone] = useState("");
  const list = usePolled(
    `scratch:${repos.map((r) => r ?? "").join(",")}`,
    async () => {
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
      if (left.length > 0) setGone((g) => [g, goneText(left)].filter((x) => x !== "").join(" "));
      const failed = all.find((x) => !x.ok);
      return failed && all.every((x) => x.items.length === 0)
        ? { ok: false, ...(failed.error ? { error: failed.error } : {}) }
        : { ok: true, data: all.flatMap((x) => x.items) };
    },
    0,
  );
  const [said, setSaid] = useState<{ text: string; ok: boolean }>();
  const items = list.data ?? [];
  const removable = items.filter((i) => i.state === "removable");
  /** What the dialog leaves in the entry's place when it closes: the last result, else what is gone. */
  const leaving = () => said ?? (gone ? { text: gone, ok: true } : undefined);
  /** Removes one debug change, or every removable one of the repositories shown. */
  const drop = async (only?: ScratchItem) => {
    const results: ScratchDropped[] = [];
    // A changed record cannot be taken out: "all" asks for the removable ones by name when some are changed.
    const targets: { repo: string | undefined; ids?: string[] }[] = only
      ? [{ repo: only.repo, ids: [only.id] }]
      : repos.flatMap((repo) => {
          const mine = items.filter((i) => i.repo === repo);
          if (mine.every((i) => i.state === "removable")) return [{ repo }];
          const ids = mine.filter((i) => i.state === "removable").map((i) => i.id);
          return ids.length > 0 ? [{ repo, ids }] : [];
        });
    const ok = await action.run(
      async (by) => {
        let last: Awaited<ReturnType<typeof client.dropScratch>> = { ok: true };
        for (const t of targets) {
          last = await client.dropScratch({ ...(t.ids ? { ids: t.ids } : {}), by }, t.repo);
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
    if (!only && result.ok && items.every((i) => i.state === "removable")) onClose(result);
    else setSaid(result);
  };
  /** Forgets a changed record: no file is touched; the person deals with its lines by hand. */
  const forget = async (item: ScratchItem) => {
    let text: string | undefined;
    const ok = await action.run(
      async (by) => {
        const r = await client.forgetScratch({ ids: [item.id], by }, item.repo);
        if (r.ok && r.data) text = forgetText(r.data);
        return r;
      },
      { who: true, refused: "Nothing was forgotten" },
    );
    if (!ok) return;
    await list.reload();
    setSaid({ text: text ?? "Forgotten.", ok: true });
  };
  return (
    <Modal
      label="Debug changes"
      className="dialog debug-changes-dialog"
      closeOnBackdrop
      onClose={() => onClose(leaving())}
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
      {gone ? (
        <div className="notice info" role="status" data-testid="debug-changes-gone">
          {gone}
        </div>
      ) : null}
      <ul className="scratch-list" data-testid="scratch-list">
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
                disabled={action.busy}
                title="Dismiss this record; your files are not touched"
                onClick={() => void forget(i)}
              >
                Forget
              </Button>
            ) : (
              <Button disabled={action.busy} onClick={() => void drop(i)}>
                Remove
              </Button>
            )}
          </li>
        ))}
        {list.data && items.length === 0 ? <li className="faint">No debug change is left.</li> : null}
      </ul>
      <div className="actions">
        <Button
          variant="primary"
          disabled={action.busy || removable.length === 0}
          data-testid="remove-debug-changes"
          onClick={() => void drop()}
        >
          Remove debug changes
        </Button>
        <Button onClick={() => onClose(leaving())}>Close</Button>
      </div>
    </Modal>
  );
}
