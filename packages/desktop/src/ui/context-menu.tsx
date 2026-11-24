/**
 * A right-click menu (S6), opened at the point of the click (ADR-0111): Radix's menu gives the
 * `menu` with its `menuitem`s, the arrow keys and type-ahead, the focus kept inside, and the close
 * on a click outside or Escape (in the capture phase, before a focused terminal takes the key).
 * It stays inside the window by itself.
 */
import { DropdownMenu } from "radix-ui";
import { cn } from "./cn.ts";

export interface MenuItem {
  readonly label: string;
  readonly key?: string | undefined;
  readonly disabled?: boolean | undefined;
  /** A thin line above the item. */
  readonly separator?: boolean | undefined;
  readonly onSelect?: (() => void) | undefined;
}

export function ContextMenu({
  at,
  items,
  label,
  onClose,
}: {
  readonly at: { readonly x: number; readonly y: number };
  readonly items: readonly MenuItem[];
  readonly label: string;
  onClose(): void;
}) {
  return (
    <DropdownMenu.Root open modal onOpenChange={(open) => (open ? undefined : onClose())}>
      {/* The menu's anchor: the point of the click. */}
      <DropdownMenu.Trigger asChild>
        <span aria-hidden="true" style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0 }} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="context-menu z-50 min-w-60 rounded-md border border-edge bg-panel p-1 text-base shadow-[0_14px_40px_var(--shadow)]"
          aria-label={label}
          align="start"
          side="bottom"
          sideOffset={0}
          collisionPadding={8}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              className={cn(
                "mi flex w-full cursor-pointer select-none justify-between gap-5 rounded px-2.5 py-1.25 text-left text-text outline-none",
                "data-highlighted:bg-hover data-disabled:cursor-default data-disabled:text-grey",
                item.separator && "sep mt-1 rounded-none border-t border-edge pt-2",
              )}
              disabled={item.disabled}
              onSelect={() => {
                item.onSelect?.();
                onClose();
              }}
            >
              <span>{item.label}</span>
              {item.key ? <kbd>{item.key}</kbd> : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
