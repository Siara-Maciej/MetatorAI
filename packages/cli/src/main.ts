#!/usr/bin/env bun
import { terminalPrompter } from "./prompts.ts";
import { run } from "./run.ts";

const code = await run(
  process.argv.slice(2),
  { out: (text) => process.stdout.write(`${text}\n`) },
  {
    stdin: () => Bun.stdin.text(),
    prompter: process.stdin.isTTY && process.stderr.isTTY ? terminalPrompter : null,
  },
);
process.exit(code);
