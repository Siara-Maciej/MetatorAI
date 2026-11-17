import { readableReason } from "../model.ts";

/** Why an escalated run stopped, readable: the error's message, its hint, the command that failed, the tries. */
export function StopReason({
  reason,
  stop,
  testId,
}: {
  readonly reason: string | undefined;
  /** The daemon's own sentence for the stop (a person's Reject, spent tries, where): it wins. */
  readonly stop?: { readonly text: string } | undefined;
  readonly testId?: string;
}) {
  const r = readableReason(stop?.text ?? reason);
  return (
    <div className="stop-reason" data-testid={testId}>
      <div className="msg">{r.text}</div>
      {r.hint ? <div className="hint">{r.hint}</div> : null}
      {r.command || r.tries ? (
        <div className="faint">
          {r.command ? (
            <>
              failed: <code>{r.command}</code>
            </>
          ) : null}
          {r.command && r.tries ? " · " : null}
          {r.tries ? `tries ${r.tries}` : null}
        </div>
      ) : null}
    </div>
  );
}
