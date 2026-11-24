/**
 * A host's command on a card (round 11): its START, cut to about two lines with "…"; a click (or
 * Enter) shows the whole command, monospace and wrapped, with Copy. Never a fragment from the
 * middle of a wrapped command.
 */

import { useState } from "react";
import { Button } from "../../ui/button.tsx";
import { commandText } from "../model/format.ts";

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
      <Button
        variant="ghost"
        className="cmd-short"
        aria-expanded={open}
        data-testid="command-short"
        title={open ? "hide the whole command" : "show the whole command"}
        onClick={() => setOpen(!open)}
      >
        {c.short}
      </Button>
      {open ? (
        <span className="cmd-full-box">
          <pre className="cmd-full mono" data-testid="command-full">
            {c.full}
          </pre>
          <Button
            variant="ghost"
            onClick={() => void navigator.clipboard?.writeText(c.full).catch(() => undefined)}
          >
            Copy
          </Button>
        </span>
      ) : null}
    </>
  );
}

/** The whole command a host's question carries (round 11), when the daemon sends one. */
export const commandOf = (q: object): string | undefined => (q as { command?: string }).command;
