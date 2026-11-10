/** A right-click menu (S6): items with their key, closed by a click outside or Escape. */
import { useEffect, useRef } from "react";

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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture: a focused terminal stops the propagation of the keys it handles, Escape included.
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  // Keep the menu inside the window.
  const style = {
    left: Math.min(at.x, Math.max(0, window.innerWidth - 260)),
    top: Math.min(at.y, Math.max(0, window.innerHeight - items.length * 30 - 20)),
  };
  return (
    <div className="context-menu" role="menu" aria-label={label} ref={ref} style={style}>
      {items.map((item) => (
        <button
          type="button"
          role="menuitem"
          key={item.label}
          className={`mi${item.separator ? " sep" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect?.();
            onClose();
          }}
        >
          <span>{item.label}</span>
          {item.key ? <kbd>{item.key}</kbd> : null}
        </button>
      ))}
    </div>
  );
}
