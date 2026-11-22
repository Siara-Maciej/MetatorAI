import { useEffect, useRef } from "react";

/**
 * A modal dialog, the same for every dialog of the app: the browser's own `<dialog>` opened with
 * `showModal()`, so the focus stays inside it, the page behind it is inert, Escape closes it and
 * the focus goes back to where it was.
 */
export function Modal({
  label,
  className = "dialog",
  closeOnBackdrop = false,
  onClose,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  /** A click outside the dialog's box closes it (the go-to picker, the help). */
  readonly closeOnBackdrop?: boolean;
  onClose(): void;
  readonly children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const before = document.activeElement;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      onMouseDown={(e) => {
        if (!closeOnBackdrop || e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        const inside =
          e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
        if (!inside) close.current();
      }}
    >
      {children}
    </dialog>
  );
}
