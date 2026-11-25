import type { InboxItem } from "../../shared/api/api.ts";
import { commandOf } from "../../shared/components/command-text.tsx";
import { commandText } from "../../shared/model/format.ts";
import { hostPromptOf } from "../../shared/model/needs.ts";
import { Button } from "../../ui/button.tsx";
import { askText } from "./model.ts";

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
      <Button className="open" data-testid="toast" title={said?.full ?? q.prompt} onClick={onOpen}>
        <span className="q">
          <span className="amber">?</span>{" "}
          {said
            ? `${q.agent ?? "the host"} asks to run: ${said.short}`
            : askText(q.agent ?? q.source, q.prompt)}
        </span>
        <span className="faint how">{inPane ? "answer in the pane ›" : "open the card ›"}</span>
      </Button>
      <Button
        variant="ghost"
        aria-label="dismiss"
        title="hide this; the question stays in the Inbox"
        onClick={onDismiss}
      >
        ✕
      </Button>
    </div>
  );
}
