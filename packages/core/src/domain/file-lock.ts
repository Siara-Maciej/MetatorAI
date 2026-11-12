import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * Who holds the lock of a shared file (`<file>.lock`): written when the lock is taken, removed
 * when it is released. A lock whose process is gone holds nothing.
 */
export const FileLockDocument = defineDocument("FileLock", {
  latest: z.strictObject({
    pid: z.number().int().positive(),
    /** Tells this holder from a later one with the same pid. */
    token: z.string().min(1),
    at: z.iso.datetime(),
  }),
  hint: "Written while a MetatorAI process changes the file next to it; delete it when no such process runs.",
});
export type FileLockHolder = { readonly pid: number; readonly token: string; readonly at: string };
