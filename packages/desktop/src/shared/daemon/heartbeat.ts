/**
 * The daemon's pulse. Its sockets stay open while the daemon is stopped or stuck (the kernel holds
 * the connection) and `/ws/events` says something only when a topic changes, so a quiet socket
 * proves nothing: the app asks `/health` every few seconds with a short deadline. A pulse that
 * gets no answer in time makes the daemon "not answering" since it was last heard; any answer
 * brings it back. Nothing at the address is not silence: that is the sockets' "no daemon".
 */
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { DaemonClient, Envelope } from "../api/api.ts";

/** How often the pulse is asked, and how long it waits for an answer (ms). */
const PULSE_MS = 4000;
const PULSE_TIMEOUT_MS = 4000;

export type PulseResult = "answered" | "timeout" | "unreachable";

export interface Pulse {
  readonly answering: boolean;
  /** When the daemon last answered a pulse. */
  readonly heardAt: number | undefined;
}

/** What one pulse's envelope means: any answer is the daemon's, even a refusal. */
export function pulseOf(r: Envelope<unknown>): PulseResult {
  if (r.ok) return "answered";
  if (r.error?.code === "TIMEOUT") return "timeout";
  return r.error?.code === "UNREACHABLE" ? "unreachable" : "answered";
}

/** The pulse after one more result; unchanged (the same object) while it says the same. */
export function pulseAfter(p: Pulse, result: PulseResult, now: number): Pulse {
  if (result === "answered") return { answering: true, heardAt: now };
  if (result === "timeout" && p.answering) return { answering: false, heardAt: p.heardAt };
  return p;
}

/** What the app shows of the pulse (app-wide, ADR-0113): whether the daemon answers, since when not. */
interface Shown {
  readonly answering: boolean;
  readonly silentSince?: number;
}

const pulseStore = createStore<Shown>(() => ({ answering: true }));
const setShown = (shown: Shown) => pulseStore.setState(shown, true);

/**
 * The pulse of the daemon at `client`'s address: whether it answers, and since when it does not.
 * Only a change of `answering` draws again; the time it was last heard is kept aside meanwhile.
 */
export function usePulse(client: DaemonClient): Shown {
  const pulse = useRef<Pulse>({ answering: true, heardAt: undefined });
  useEffect(() => {
    let closed = false;
    pulse.current = { answering: true, heardAt: undefined };
    setShown({ answering: true });
    const beat = async () => {
      const r = await client.health(PULSE_TIMEOUT_MS);
      if (closed) return;
      const before = pulse.current;
      const next = pulseAfter(before, pulseOf(r), Date.now());
      pulse.current = next;
      if (next.answering !== before.answering)
        setShown(
          next.answering
            ? { answering: true }
            : { answering: false, silentSince: next.heardAt ?? Date.now() },
        );
    };
    void beat();
    const timer = setInterval(() => void beat(), PULSE_MS);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [client]);
  return useStore(pulseStore, (s) => s);
}
