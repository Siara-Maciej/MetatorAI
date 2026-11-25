import type { ReactNode } from "react";
import { Button } from "../../ui/button.tsx";

/** One row of the sidebar: glyph, name, the state's word, one dim line. */
export function Row({
  glyph,
  name,
  sub,
  word,
  tone,
  current,
  nested = false,
  className = "",
  ...rest
}: {
  readonly glyph: ReactNode;
  readonly name: ReactNode;
  readonly sub?: ReactNode;
  readonly word?: string | undefined;
  readonly tone?: string | undefined;
  readonly current?: boolean | undefined;
  readonly nested?: boolean;
  readonly className?: string;
  readonly title?: string | undefined;
  readonly "data-testid"?: string | undefined;
  onClick(): void;
}) {
  return (
    <Button
      className={`row${nested ? " nested" : ""} ${className}`}
      aria-current={current ? "true" : undefined}
      {...rest}
    >
      {glyph}
      <span className="text">
        <span className="title">{name}</span>
        {sub ? <span className="sub">{sub}</span> : null}
      </span>
      {word ? <span className={`word kind ${tone ?? ""}`}>{word}</span> : null}
    </Button>
  );
}
