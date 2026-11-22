import { createHash } from "node:crypto";
import type { ContentHasher } from "@metator/core";

/** `ContentHasher` on node:crypto: the SHA-256 of a file's text, for the Backlog's snapshots (ADR-0096). */
export class NodeContentHasher implements ContentHasher {
  sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }
}
