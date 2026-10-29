#!/usr/bin/env bun
import { run } from "./run.ts";
import { clackTerminal } from "./terminal.ts";

// The last write is awaited before exit (writes to stdout complete in order): `process.exit` would cut output a slow pipe has not read
// yet (64 KiB is a pipe's buffer).
let written: Promise<unknown> = Promise.resolve();
const code = await run(
  process.argv.slice(2),
  {
    out: (text) => {
      written = new Promise((done) => process.stdout.write(`${text}\n`, () => done(undefined)));
    },
  },
  {
    stdin: () => Bun.stdin.text(),
    terminal: process.stdin.isTTY && process.stderr.isTTY ? clackTerminal : null,
  },
);
await written;
process.exit(code);
