import { useState } from "react";
import { Button } from "./button.tsx";

/**
 * Copies `text` to the clipboard and says "copied" once it did (each copy of the button for
 * itself); a browser that refuses says nothing.
 */
export function CopyButton({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      onClick={() =>
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }
    >
      {copied ? "copied" : "copy"}
    </Button>
  );
}
