import type { Activity } from "../api.ts";
import { byStage, clock } from "../model.ts";

/** Where an event comes from, in one word: the hook, the terminal, the run, the inbox, or its agent. */
const sourceOf = (e: Activity): string => e.origin ?? (e.agent ? `agent ${e.agent}` : "run");

/**
 * A run's events, the same wherever they are listed: a table (the session's Events), a plain
 * list (the plan's last events), or one list per stage (the briefing).
 */
export function ActivityList({
  entries,
  variant,
  empty,
}: {
  readonly entries: readonly Activity[];
  readonly variant: "table" | "list" | "by-stage";
  /** What to say when nothing happened. */
  readonly empty?: string | undefined;
}) {
  if (entries.length === 0 && empty) return <div className="empty">{empty}</div>;
  if (variant === "table")
    return (
      <div className="events">
        <table>
          <thead>
            <tr>
              <th scope="col">time</th>
              <th scope="col">type</th>
              <th scope="col">source</th>
              <th scope="col">what</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.at}-${String(i)}`}>
                <td className="time">{clock(e.at)}</td>
                <td className="type">{e.type}</td>
                <td className="src">{sourceOf(e)}</td>
                <td>{e.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  const list = (items: readonly Activity[], label: string) => (
    <ul className={`timeline${variant === "list" ? " plain" : ""}`} aria-label={label}>
      {items.map((e, i) => (
        <li key={`${e.at}-${String(i)}`} className={`${e.type}${e.type === "question" ? " amber" : ""}`}>
          <span className="t faint mono">{clock(e.at)}</span>{" "}
          {variant === "by-stage" ? <span className="faint">{e.type} · </span> : null}
          {variant === "list" && e.agent ? `${e.agent} ` : ""}
          {e.text}
        </li>
      ))}
    </ul>
  );
  if (variant === "list") return list(entries, "timeline");
  return (
    <>
      {byStage(entries).map(([stage, items]) => (
        <section key={stage}>
          <h3>{stage}</h3>
          {list(items, `events of ${stage}`)}
        </section>
      ))}
    </>
  );
}
