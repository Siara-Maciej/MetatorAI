/**
 * The daemon's push channel, opened for the daemon the app shows (ADR-0110): one socket on
 * `/ws/events` (opened again after it drops, `partysocket`), each message read by `readEvent`, and
 * the queries of the topics it names read again. While it is live the polled requests are only a
 * fallback (`intervalOf`). A daemon without the channel (it never said hello, and three tries
 * failed) is not asked again: the app polls as before.
 */
import { WebSocket as ReconnectingWebSocket } from "partysocket";
import { useEffect } from "react";
import { wsUrl } from "../api/api.ts";
import { NO_CHANNEL, readEvent } from "../api/events.ts";
import { queryClient, readAgain, setPushLive } from "../api/query.ts";

/** Failed tries before a daemon that never said hello is taken as one without the channel. */
const GIVE_UP_AFTER = 3;

export function useDaemonEvents(url: string): void {
  useEffect(() => {
    const ws = new ReconnectingWebSocket(wsUrl(url, "/ws/events"), [], {
      minReconnectionDelay: 1000,
      maxReconnectionDelay: 10_000,
    });
    let channel = NO_CHANNEL;
    // Tries that failed before the channel ever said hello: a daemon without it, after three.
    let failed = 0;
    ws.onmessage = (m: MessageEvent) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(m.data));
      } catch {
        return;
      }
      const r = readEvent(channel, raw);
      channel = r.channel;
      setPushLive(true);
      void readAgain(queryClient, url, r.read);
    };
    ws.onclose = () => {
      setPushLive(false);
      if (channel.epoch !== undefined) return;
      failed += 1;
      if (failed >= GIVE_UP_AFTER) ws.close();
    };
    return () => {
      ws.close();
      setPushLive(false);
    };
  }, [url]);
}
