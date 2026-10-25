import type { Clock, FileSystem, ImportGraphReader, Logger, ProcessRunner, Vcs } from "@metator/core";
import { token } from "./container.ts";

/** Well-known tokens for core ports. Plugins bind implementations; use cases resolve them. */
export const Tokens = {
  Clock: token<Clock>("Clock"),
  Logger: token<Logger>("Logger"),
  FileSystem: token<FileSystem>("FileSystem"),
  ProcessRunner: token<ProcessRunner>("ProcessRunner"),
  Vcs: token<Vcs>("Vcs"),
  ImportGraphReader: token<ImportGraphReader>("ImportGraphReader"),
} as const;
