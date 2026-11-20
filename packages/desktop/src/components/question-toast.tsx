import type { InboxItem } from "../api.ts";
import { askText, commandText, hostPromptOf } from "../model.ts";
import { commandOf } from "./command-text.tsx";

/** The workbench's one toast (`notify.channel: app`): the newest question, how to answer it, a way to hide it. */
export function QuestionToast({
  item,
  onOpen,
  onDismiss,
}: {
  readonly item: InboxItem;
  onOpen(): void;
  onDismiss(): void;
}) {
  const q = item.question;
  /** The host's own prompt is answered in its pane; every other question on its card. */
  const inPane = q.source === "permission";
  // A host's question: the start of its command, cut; the card shows it all.
  const said = inPane
    ? commandText({ prompt: hostPromptOf(q.prompt)?.text || q.prompt, command: commandOf(q) }, 120)
    : undefined;
  return (
    <div className="toast" role="status">
      <button
        type="button"
        className="open"
        data-testid="toast"
        title={said?.full ?? q.prompt}
        onClick={onOpen}
      >
        <span className="q">
          <span className="amber">?</span>{" "}
          {said
            ? `${q.agent ?? "the host"} asks to run: ${said.short}`
            : askText(q.agent ?? q.source, q.prompt)}
        </span>
        <span className="faint how">{inPane ? "answer in the pane ›" : "open the card ›"}</span>
      </button>
      <button
        type="button"
        className="ghost"
        aria-label="dismiss"
        title="hide this; the question stays in the Inbox"
        onClick={onDismiss}
      >
        ✕
      </button>
    </div>
  );
}
