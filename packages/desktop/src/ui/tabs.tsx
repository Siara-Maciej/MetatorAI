/**
 * One row of tabs, the same everywhere a screen switches between views of one thing (ADR-0111):
 * Radix's tabs give the `tablist` with its `tab`s, the chosen one `aria-selected`, the arrow keys
 * along the row (choosing as they move) and one tab stop. The views themselves are the caller's.
 */
import { Tabs as Radix } from "radix-ui";
import type { ReactNode } from "react";

export interface TabItem<Id extends string> {
  readonly id: Id;
  readonly label: ReactNode;
  readonly title?: string | undefined;
  /** Drawn beside the tab, outside its button: a state chip, a close button. */
  readonly after?: ReactNode;
  onContextMenu?: ((e: React.MouseEvent) => void) | undefined;
}

export function Tabs<Id extends string>({
  label,
  items,
  current,
  onSelect,
  className = "tabs",
  testId,
  children,
  before,
}: {
  readonly label: string;
  /** The tabs; their ids are of the type of `current`. */
  readonly items: readonly TabItem<NoInfer<Id>>[];
  readonly current: Id | undefined;
  onSelect(id: Id): void;
  readonly className?: string;
  readonly testId?: string | undefined;
  /** What follows the tabs on the same row (a spacer, a button). */
  readonly children?: ReactNode;
  /** What stands before the tabs on the same row (the Terminals' workspace switch). */
  readonly before?: ReactNode;
}) {
  // With nothing chosen yet, the first tab is the row's tab stop.
  const value = current ?? items[0]?.id ?? "";
  return (
    <Radix.Root asChild value={value} onValueChange={(id) => onSelect(id as Id)} activationMode="automatic">
      <Radix.List className={className} aria-label={label} data-testid={testId} loop>
        {before}
        {items.map((t) => {
          const tab = (
            <Radix.Trigger
              key={t.id}
              value={t.id}
              title={t.title}
              aria-selected={t.id === current}
              onContextMenu={t.onContextMenu}
            >
              {t.label}
            </Radix.Trigger>
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
      </Radix.List>
    </Radix.Root>
  );
}
