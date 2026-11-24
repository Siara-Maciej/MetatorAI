/**
 * What an action answered (D5): a notice that stays until it is closed or replaced.
 */

/**
 * What an action answered (D5): it stays until the person closes it or the next action replaces
 * it; a refresh of the screen's data never clears it.
 */
export function Notice({
  text,
  tone = "error",
  action,
  onClose,
}: {
  readonly text: string | undefined;
  readonly tone?: "error" | "info";
  /** One way past what the notice says (a refused start: "Start from the last commit"). */
  readonly action?: { readonly label: string; run(): void } | undefined;
  onClose(): void;
}) {
  if (!text) return null;
  return (
    <div className={`banner notice ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="msg">{text}</span>
      {action ? (
        <button type="button" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
      <button type="button" className="ghost" aria-label="dismiss" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
