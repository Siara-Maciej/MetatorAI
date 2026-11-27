/**
 * The Backlog's list (ADR-0113): the list draws the rows by id; a row reads its own task and only
 * whether it is the one chosen, so choosing another draws two rows again, not the list.
 */
import { Glyph } from "../../shared/components/glyph.tsx";
import { useDaemon, useRun } from "../../shared/daemon/daemon.tsx";
import { duration } from "../../shared/model/format.ts";
import { EmptyRow, ListRow, ListSection } from "../../ui/list-detail.tsx";
import { useIsCurrent, useIssue, useIssues, useRowIds } from "./data.ts";
import { itemTone, itemWord, rowSub } from "./model.ts";
import { useBacklog } from "./state.ts";

interface RowId {
  readonly id: string;
  readonly child: boolean;
}

export function BacklogList() {
  const rows = useRowIds();
  const proposals = rows.proposals.filter((r) => !r.child).length;
  const open = rows.open.filter((r) => !r.child).length;
  return (
    <>
      {proposals > 0 ? <ListSection>agents' proposals · {proposals}</ListSection> : null}
      <Rows rows={rows.proposals} />
      <ListSection>open · {open}</ListSection>
      <Rows rows={rows.open} />
      <Reading empty={open === 0 && proposals === 0} />
      <span className="spacer" />
      <Finished rows={rows.finished} />
    </>
  );
}

function Rows({ rows }: { readonly rows: readonly RowId[] }) {
  return rows.map((r) => <IssueRow key={r.id} id={r.id} child={r.child} />);
}

/** Empty only when the daemon said so: not while the tasks are read, not when the read failed. */
function Reading({ empty }: { readonly empty: boolean }) {
  const read = useIssues((issues) => issues !== undefined);
  if (!read) return <EmptyRow>Reading the tasks…</EmptyRow>;
  return empty ? <EmptyRow>Nothing open. + task adds one.</EmptyRow> : null;
}

function Finished({ rows }: { readonly rows: readonly RowId[] }) {
  const showDone = useBacklog((s) => s.showDone);
  const toggleDone = useBacklog((s) => s.toggleDone);
  const count = rows.filter((r) => !r.child).length;
  if (count === 0) return null;
  return (
    <>
      <ListRow
        className="item dim"
        onSelect={toggleDone}
        title={`finished · ${count} ${showDone ? "▾" : "▸"}`}
      />
      {showDone ? <Rows rows={rows} /> : null}
    </>
  );
}

function IssueRow({ id, child }: RowId) {
  const item = useIssue(id);
  const selected = useIsCurrent(id);
  const pick = useBacklog((s) => s.pick);
  if (!item) return null;
  const word = itemWord(item);
  return (
    <ListRow
      className={`item${child ? " child" : ""}`}
      selected={selected}
      onSelect={() => pick(id)}
      testId={`issue-${id}`}
      glyph={<Glyph kind="issue" state={item.status} />}
      title={item.title}
      sub={<RowSub id={id} />}
      trailing={
        item.status === "proposed" ? (
          <span className={`pr ${item.priority}`}>
            {duration(Date.now() - new Date(item.createdAt).getTime())}
          </span>
        ) : (
          <span className={`word ${itemTone(word)}`}>{word}</span>
        )
      }
    />
  );
}

/** A row's second line: who proposed it, or a parent's progress, or what a child waits for. */
function RowSub({ id }: { readonly id: string }) {
  const item = useIssue(id);
  // A parent's progress, a child's wait: from the whole list, but only this line is kept.
  const sub = useIssues((issues) => {
    const it = issues?.find((i) => i.id === id);
    return it && issues ? rowSub(it, issues) : undefined;
  });
  const { repo } = useDaemon("repo");
  const proposing = useRun(item?.proposedBy?.runId, repo);
  if (!item) return null;
  if (item.proposedBy && item.status === "proposed")
    return (
      <>
        {item.proposedBy.agent}
        {item.proposedBy.runId ? ` · ${proposing?.task ?? item.proposedBy.runId}` : ""}
      </>
    );
  return sub ?? null;
}
