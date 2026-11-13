import type { ReactNode } from "react";

export interface TabItem<Id extends string> {
  readonly id: Id;
  readonly label: ReactNode;
  readonly title?: string | undefined;
  /** Drawn beside the tab, outside its button: a state chip, a close button. */
  readonly after?: ReactNode;
  onContextMenu?: ((e: React.MouseEvent) => void) | undefined;
}

/**
 * One row of tabs, the same everywhere a screen switches between views of one thing: `tablist`
 * with `tab`s, the chosen one `aria-selected`, the arrow keys move along the row, and only the
 * chosen tab is a tab stop.
 */
export function Tabs<Id extends string>({
  label,
  items,
  current,
  onSelect,
  className = "tabs",
  testId,
  children,
}: {
  readonly label: string;
  readonly items: readonly TabItem<Id>[];
  readonly current: Id | undefined;
  onSelect(id: Id): void;
  readonly className?: string;
  readonly testId?: string | undefined;
  /** What follows the tabs on the same row (a spacer, a button). */
  readonly children?: ReactNode;
}) {
  const move = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0 || items.length === 0) return;
    e.preventDefault();
    const next = items[(index + step + items.length) % items.length];
    if (!next) return;
    onSelect(next.id);
    const row = e.currentTarget.closest('[role="tablist"]');
    row?.querySelectorAll<HTMLElement>('[role="tab"]')[(index + step + items.length) % items.length]?.focus();
  };
  return (
    <div className={className} role="tablist" aria-label={label} data-testid={testId}>
      {items.map((t, i) => {
        const tab = (
          <button
            type="button"
            role="tab"
            key={t.id}
            aria-selected={t.id === current}
            tabIndex={t.id === current || (current === undefined && i === 0) ? 0 : -1}
            title={t.title}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => move(e, i)}
            onContextMenu={t.onContextMenu}
          >
            {t.label}
          </button>
        );
        return t.after !== undefined ? (
          <span key={t.id} className="tab-with">
            {tab}
            {t.after}
          </span>
        ) : (
          tab
        );
      })}
      {children}
    </div>
  );
}
