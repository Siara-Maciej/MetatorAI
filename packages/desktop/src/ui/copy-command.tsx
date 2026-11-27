/**
 * A command copied with one click (round 22): the button says "copied" for a moment; when the
 * clipboard is refused, the command is shown to select by hand. Its text is the button's tooltip.
 * A primitive of `ui/`: what it says for a moment is its own state.
 */
import { useState } from "react";
import { Button } from "./button.tsx";

export function CopyCommand({
  command,
  label,
  className,
  shownClassName,
  testId,
}: {
  readonly command: string;
  /** What the button says before the click. */
  readonly label: string;
  readonly className?: string | undefined;
  /** The class of the command shown when the clipboard is refused. */
  readonly shownClassName?: string | undefined;
  readonly testId?: string | undefined;
}) {
  const [said, setSaid] = useState<"copied" | "shown">();
  if (said === "shown") return <code className={shownClassName}>{command}</code>;
  return (
    <Button
      variant="ghost"
      className={className}
      title={command}
      data-testid={testId}
      onClick={() => {
        const show = () => setSaid("shown");
        if (typeof navigator === "undefined" || !navigator.clipboard) return show();
        navigator.clipboard.writeText(command).then(() => {
          setSaid("copied");
          setTimeout(() => setSaid(undefined), 1500);
        }, show);
      }}
    >
      {said === "copied" ? "copied" : label}
    </Button>
  );
}
