import { callDaemon, findDaemon } from "./daemon-client.ts";

/**
 * A question of a pane (ADR-0091): its host's approval prompt, or what its agent asked in words.
 * It lives in the daemon that owns the pane, so `metator inbox` asks the daemon for them.
 */
export interface PaneAsk {
  readonly paneId: string;
  readonly repo?: string;
  readonly runId?: string;
  readonly label: string;
  readonly host: string;
  readonly question: {
    readonly id: string;
    readonly source: "agent" | "permission";
    readonly prompt: string;
    readonly command?: string;
    readonly reason?: string;
    readonly askedAt: string;
    readonly options: readonly { readonly label: string }[];
  };
}

/** The open questions of the panes of the daemon that serves this directory; none when no daemon runs. */
export async function paneAsks(start: string): Promise<PaneAsk[]> {
  const daemon = findDaemon(start);
  if (daemon.isErr()) return [];
  const inbox = await callDaemon<{ panes?: PaneAsk[] }>(daemon.value, "GET", "/inbox", undefined, {}, 5_000);
  return inbox.isOk() ? [...(inbox.value.panes ?? [])] : [];
}
