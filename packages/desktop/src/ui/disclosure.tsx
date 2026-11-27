import { type ReactNode, useState } from "react";

/**
 * Something that opens and closes in place (a long command, a folded list): the primitive keeps
 * whether it is open, per copy, and draws `children` with it. Opening one draws only that one.
 */
export function Disclosure({
  children,
}: {
  readonly children: (open: boolean, setOpen: (open: boolean) => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return children(open, setOpen);
}
