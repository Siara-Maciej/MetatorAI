import type { Tone } from "../model.ts";

export const Chip = ({
  tone,
  children,
}: {
  readonly tone?: Tone | undefined;
  readonly children: React.ReactNode;
}) => <span className={`chip${tone ? ` ${tone}` : ""}`}>{children}</span>;
