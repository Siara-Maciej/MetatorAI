import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/** Where the daemon listens (`.metator/daemon.json`), so the CLI and the clients find it (R1). */
export const DaemonInfoDocument = defineDocument("DaemonInfo", {
  latest: z.strictObject({
    url: z.string().url(),
    pid: z.number().int().positive(),
    startedAt: z.iso.datetime(),
  }),
  hint: "Written by `metator serve` while it runs; stale when its pid is gone.",
});
export type DaemonInfo = { readonly url: string; readonly pid: number; readonly startedAt: string };
export const DAEMON_FILE = ".metator/daemon.json";
