/**
 * The daemon's push channel, opened for the daemon the app shows (ADR-0110): one socket on
 * `/ws/events` (opened again after it drops, `partysocket`), each message read by `readEvent`, and
 * the queries of the topics it names read again. While it is live the polled requests are only a
 * fallback (`intervalOf`). A daemon without the channel never opens it: the app polls as before.
 */
import { WebSocket as ReconnectingWebSocket } from "partysocket";
import { useEffect } from "react";
import { wsUrl } from "../api/api.ts";
import { NO_CHANNEL, readEvent } from "../api/events.ts";
import { queryClient, readAgain, setPushLive } from "../api/query.ts";

export function useDaemonEvents(url: string): void {
  useEffect(() => {
    const ws = new ReconnectingWebSocket(wsUrl(url, "/ws/events"), [], {
      minReconnectionDelay: 1000,
      maxReconnectionDelay: 10_000,
    });
    let channel = NO_CHANNEL;
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
    ws.onclose = () => setPushLive(false);
    return () => {
      ws.close();
      setPushLive(false);
    };
  }, [url]);
}
