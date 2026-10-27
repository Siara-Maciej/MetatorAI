#!/usr/bin/env bun
import { run } from "./run.ts";
import { clackTerminal } from "./terminal.ts";

const code = await run(
  process.argv.slice(2),
  { out: (text) => process.stdout.write(`${text}\n`) },
  {
    stdin: () => Bun.stdin.text(),
    terminal: process.stdin.isTTY && process.stderr.isTTY ? clackTerminal : null,
  },
);
process.exit(code);
