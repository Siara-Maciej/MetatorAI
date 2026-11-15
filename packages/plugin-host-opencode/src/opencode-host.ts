import type { HostDescriptor } from "@metator/core";
import { OpencodeInteractiveHost } from "./opencode-interactive-host.ts";

/** OpenCode as the composition root sees it: an interactive session only; MetatorAI writes it no files. */
export const opencodeHost: HostDescriptor = {
  id: "opencode",
  program: { env: "METATOR_OPENCODE_BIN", default: "opencode" },
  interactive: (terminal, bin) => new OpencodeInteractiveHost(terminal, bin),
};
