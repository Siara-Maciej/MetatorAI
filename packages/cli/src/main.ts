#!/usr/bin/env bun
import { run } from "./run.ts";

const code = await run(process.argv.slice(2), { out: (text) => process.stdout.write(`${text}\n`) });
process.exit(code);
