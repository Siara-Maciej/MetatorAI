/**
 * How fresh what a screen shows is: one line over the data the daemon gave. Nothing while the data
 * is fresh or not here yet; "could not be read" with Try again when there is none; "Not up to
 * date: no answer since …" with Try now when the reads after a good one fail (the data stays, it
 * is not emptied). The time ticks only while the line shows, so a quiet window draws nothing.
 */
import { useEffect, useState } from "react";
import { Button } from "../../ui/button.tsx";
import { cn } from "../../ui/cn.ts";
import type { Polled } from "../api/query.ts";
import { useDaemon } from "../daemon/daemon.tsx";
import { readingOfAll, staleText } from "../model/freshness.ts";

type Read = Pick<Polled<unknown>, "data" | "error" | "updatedAt" | "reload">;

/** The time now, every `ms` while `on`; frozen otherwise. */
function useNow(ms: number, on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms, on]);
  return now;
}

function Line({
  tone,
  text,
  action,
  onAction,
  state,
}: {
  readonly tone: "red" | "amber";
  readonly text: string;
  readonly action?: string | undefined;
  onAction?: (() => void) | undefined;
  readonly state: string;
}) {
  return (
    <div
      className={cn(
        "freshness tw:flex tw:items-center tw:gap-sp-4 tw:border-b tw:border-edge tw:px-3.5 tw:py-2 tw:text-compact",
        tone === "red" ? "tw:bg-red/8 tw:text-red" : "tw:bg-amber/8 tw:text-amber",
      )}
      role={tone === "red" ? "alert" : "status"}
      data-testid="freshness"
      data-state={state}
    >
      <span className="tw:flex-1 tw:[overflow-wrap:anywhere]">{text}</span>
      {action && onAction ? (
        <Button variant="ghost" className="tw:text-inherit" onClick={onAction}>
          {action}
        </Button>
      ) : null}
    </div>
  );
}

/** The line for the reads a screen shows (`what`: "the tasks"); several reads say the worst of them. */
export function Freshness({ reads, what }: { readonly reads: readonly Read[]; readonly what: string }) {
  const reading = readingOfAll(reads);
  const now = useNow(1000, reading === "stale");
  const again = () => void Promise.all(reads.map((r) => r.reload()));
  if (reading === "failed") {
    const error = reads.find((r) => r.data === undefined && r.error)?.error ?? "";
    return (
      <Line
        tone="red"
        state="failed"
        text={`${what} could not be read: ${error}`}
        action="Try again"
        onAction={again}
      />
    );
  }
  if (reading !== "stale") return null;
  const stale = reads.filter((r) => r.data !== undefined && r.error !== undefined);
  const since = Math.min(...stale.map((r) => r.updatedAt ?? Number.POSITIVE_INFINITY));
  const text = staleText(Number.isFinite(since) ? since : undefined, now, stale[0]?.error ?? "");
  return <Line tone="amber" state="stale" text={text} action="Try now" onAction={again} />;
}

/**
 * The same line for what comes over the daemon's sockets (Home's decisions, the sidebar): they
 * stay open while the daemon is stopped or stuck, so its pulse says whether what shows is current.
 */
export function DaemonFreshness() {
  const { connected, answering, silentSince } = useDaemon("connected", "answering", "silentSince");
  const silent = connected && !answering;
  const now = useNow(1000, silent);
  if (!silent) return null;
  return (
    <Line
      tone="amber"
      state="stale"
      text={staleText(
        silentSince,
        now,
        "The daemon holds the connection but does not answer; what you see is from then.",
      )}
    />
  );
}
