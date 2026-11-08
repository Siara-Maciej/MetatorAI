import type { Attention } from "../api.ts";

export const Chip = ({
  tone,
  children,
}: {
  readonly tone?: "amber" | "red" | "green" | "blue" | "violet" | "teal";
  readonly children: React.ReactNode;
}) => <span className={`chip${tone ? ` ${tone}` : ""}`}>{children}</span>;

export const Chips = ({ items }: { readonly items: readonly React.ReactNode[] }) => (
  <span className="chips">
    {items.map((c, i) =>
      typeof c === "string" ? <Chip key={c}>{c}</Chip> : <span key={String(i)}>{c}</span>,
    )}
  </span>
);

export const Dot = ({ attention, human }: { readonly attention: Attention; readonly human?: boolean }) => (
  <span className={`dot ${human ? "human" : attention}`} aria-hidden="true" />
);

/** What a state reads as on a row: `waits for you`, `driving`, … */
export const attentionLabel = (a: Attention): string =>
  a === "you" ? "waits for you" : a === "driving" ? "working" : a;
