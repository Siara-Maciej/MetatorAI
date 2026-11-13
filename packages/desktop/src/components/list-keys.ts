/**
 * The arrow keys and `j`/`k` in a list of rows: the focus goes to the row after or before the one
 * that has it, and with `activate` that row is chosen as if clicked. Returns whether the key was one of these.
 */
export function moveInList(e: React.KeyboardEvent<HTMLElement>, selector: string, activate = false): boolean {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  const step =
    e.key === "ArrowDown" || (e.key === "j" && !typing)
      ? 1
      : e.key === "ArrowUp" || (e.key === "k" && !typing)
        ? -1
        : 0;
  if (step === 0 || e.ctrlKey || e.metaKey || e.altKey || typing) return false;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)];
  if (rows.length === 0) return false;
  const at = rows.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
  const next = rows[at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length];
  if (!next) return false;
  e.preventDefault();
  e.stopPropagation();
  next.focus();
  if (activate) next.click();
  return true;
}
