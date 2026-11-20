/**
 * A host's command on a card (round 11): its START, cut to about two lines with "…"; a click (or
 * Enter) shows the whole command, monospace and wrapped, with Copy. Never a fragment from the
 * middle of a wrapped command.
 */
import { useState } from "react";
import { commandText } from "../model.ts";

export function CommandText({
  prompt,
  command,
}: {
  /** What to show without a command: the host's text, else the question's prompt. */
  readonly prompt: string;
  readonly command?: string | undefined;
}) {
  const c = commandText({ prompt, command });
  const [open, setOpen] = useState(false);
  if (!c.cut) return <span data-testid="command-short">{c.short}</span>;
  return (
    <>
      <button
        type="button"
        className="ghost cmd-short"
        aria-expanded={open}
        data-testid="command-short"
        title={open ? "hide the whole command" : "show the whole command"}
        onClick={() => setOpen(!open)}
      >
        {c.short}
      </button>
      {open ? (
        <span className="cmd-full-box">
          <pre className="cmd-full mono" data-testid="command-full">
            {c.full}
          </pre>
          <button
            type="button"
            className="ghost"
            onClick={() => void navigator.clipboard?.writeText(c.full).catch(() => undefined)}
          >
            Copy
          </button>
        </span>
      ) : null}
    </>
  );
}

/** The whole command a host's question carries (round 11), when the daemon sends one. */
export const commandOf = (q: object): string | undefined => (q as { command?: string }).command;
