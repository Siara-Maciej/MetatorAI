/**
 * The frame of every list screen (plan, backlog, changes, open MRs): an optional line on top, a
 * list on the left, the chosen item on the right. `ListRow` is a row of such a list: a glyph, a
 * title with one line under it, something at the end.
 */
import type { ReactNode } from "react";
import { moveInList } from "./list-keys.ts";

export function ListDetail({
  className,
  testId,
  top,
  list,
  listLabel,
  detailClass = "",
  children,
}: {
  /** The screen's own class (`backlog`, `plan`, `review`): its width of the list and its extras. */
  readonly className: string;
  readonly testId?: string | undefined;
  readonly top?: ReactNode;
  readonly list: ReactNode;
  readonly listLabel: string;
  readonly detailClass?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={`ld ${className}${top ? "" : " no-top"}`} data-testid={testId}>
      {top ? <div className="ld-top">{top}</div> : null}
      <div className="ld-body">
        {/* The arrow keys and j/k move along the rows and choose the one they land on. */}
        <aside
          className="ld-list"
          aria-label={listLabel}
          onKeyDown={(e) => moveInList(e, "button.ld-row", true)}
        >
          {list}
        </aside>
        <section className={`ld-detail ${detailClass}`}>{children}</section>
      </div>
    </div>
  );
}

/** The small heading of a part of the list: `open · 3`. */
export const ListSection = ({ children }: { readonly children: ReactNode }) => (
  <div className="ld-sec">{children}</div>
);

/** What a list says when it has nothing. */
export const EmptyRow = ({ children }: { readonly children: ReactNode }) => (
  <div className="empty-row">{children}</div>
);

export function ListRow({
  glyph,
  title,
  sub,
  trailing,
  selected,
  onSelect,
  testId,
  hint,
  className = "",
}: {
  readonly glyph?: ReactNode;
  readonly title: ReactNode;
  /** One line under the title, cut at the row's width. */
  readonly sub?: ReactNode;
  readonly trailing?: ReactNode;
  readonly selected?: boolean | undefined;
  /** With it the row is a button; without, it only shows. */
  onSelect?: (() => void) | undefined;
  readonly testId?: string | undefined;
  readonly hint?: string | undefined;
  readonly className?: string;
}) {
  const body = (
    <>
      {glyph ?? <span className="g" />}
      <span className="n">
        {title}
        {sub ? <span className="sub">{sub}</span> : null}
      </span>
      {trailing !== undefined ? <span className="trail">{trailing}</span> : null}
    </>
  );
  const cls = `ld-row ${className}${selected ? " sel" : ""}`;
  return onSelect ? (
    <button
      type="button"
      className={cls}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      data-testid={testId}
      title={hint}
    >
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={testId} title={hint}>
      {body}
    </div>
  );
}
