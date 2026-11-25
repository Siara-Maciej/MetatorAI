import { useState } from "react";
import { Button } from "../../ui/button.tsx";
import { compactLines } from "../model/format.ts";

/**
 * A list that may be long, kept short: a line repeated is one line with `×N`, the newest `keep`
 * are shown, and "N more" opens the rest. A card's "Since you left" never pushes its options off
 * the screen.
 */
export function FoldList({
  lines,
  keep = 4,
  label,
  className,
}: {
  readonly lines: readonly string[];
  readonly keep?: number;
  readonly label: string;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { shown, hidden } = compactLines(lines, open ? Number.POSITIVE_INFINITY : keep);
  return (
    <div className={`fold-list ${className ?? ""}`}>
      {hidden > 0 ? (
        <Button variant="ghost" className="more" aria-expanded={false} onClick={() => setOpen(true)}>
          {hidden} more {hidden === 1 ? "line" : "lines"} before these
        </Button>
      ) : null}
      <ul aria-label={label}>
        {shown.map((l) => (
          <li key={l.text}>
            {l.text}
            {l.times > 1 ? <span className="faint"> ×{l.times}</span> : null}
          </li>
        ))}
      </ul>
      {open && lines.length > keep ? (
        <Button variant="ghost" className="more" aria-expanded={true} onClick={() => setOpen(false)}>
          Show fewer
        </Button>
      ) : null}
    </div>
  );
}
