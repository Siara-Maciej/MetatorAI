import { fileLockContract } from "@metator/testing";
import { InProcessLock } from "../src/domain/in-process-lock.ts";

// The queue a store falls back to has the port's shape: it passes the port's contract.
fileLockContract("InProcessLock", async () => new InProcessLock());
