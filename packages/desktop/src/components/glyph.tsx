import { type LookKind, lookOf } from "../model.ts";

/** The glyph of a state in its colour (model.ts `LOOKS`): one table for every list of the app. */
export const Glyph = ({
  kind,
  state,
  dot = false,
}: {
  readonly kind: LookKind;
  readonly state: string | undefined;
  /** A plain dot in the state's colour instead of its symbol (`ui.statusIndicators: dots`). */
  readonly dot?: boolean;
}) => {
  const look = lookOf(kind, state);
  return (
    <span className={`g${look.tone ? ` ${look.tone}` : ""}`} aria-hidden="true">
      {dot ? "●" : look.glyph}
    </span>
  );
};

/** A word in the colour of a state: `working`, `asks`, `idle`, `exited`. */
export const StateWord = ({
  kind,
  state,
  children,
}: {
  readonly kind: LookKind;
  readonly state: string | undefined;
  readonly children?: React.ReactNode;
}) => <span className={lookOf(kind, state).tone}>{children ?? state}</span>;
