import { readableReason } from "../model.ts";

/** Why an escalated run stopped, readable: the error's message, its hint, the command that failed, the tries. */
export function StopReason({
  reason,
  testId,
}: {
  readonly reason: string | undefined;
  readonly testId?: string;
}) {
  const r = readableReason(reason);
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
