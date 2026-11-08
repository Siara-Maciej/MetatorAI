import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrControl } from "@metator/core";

/**
 * A stand-in for the herdr CLI (E2): a Bun script that keeps workspaces and panes in a JSON file,
 * answers like herdr (`{"result": …}` on stdout, `{"error": {code, message}}` on stderr with exit
 * 1), and logs every argv to `calls.jsonl`. It proves what an adapter sends and how it reads the
 * answers where herdr itself is not installed; it is not herdr.
 */
export function standInHerdr(dir: string): {
  readonly bin: string;
  calls(): string[][];
  setAgentStatus(pane: string, status: string): void;
} {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "herdr");
  const state = join(dir, "state.json");
  const log = join(dir, "calls.jsonl");
  writeFileSync(state, JSON.stringify({ n: 0, panes: {} }));
  writeFileSync(log, "");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
const out = (result) => { process.stdout.write(JSON.stringify({ id: "cli", result }) + "\\n"); process.exit(0); };
const fail = (code, message) => { process.stderr.write(JSON.stringify({ error: { code, message } }) + "\\n"); process.exit(1); };
const [group, verb, target] = args;
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (group === "workspace" && verb === "create") {
  const w = "w" + ++s.n; const p = w + ":p1";
  s.panes[p] = { workspace: w, cwd: opt("--cwd"), label: opt("--label"), env: args.filter((a, i) => args[i - 1] === "--env"), typed: [] };
  save();
  out({ type: "workspace_created", workspace: { workspace_id: w, label: opt("--label") }, tab: { tab_id: w + ":t1" }, root_pane: { pane_id: p } });
}
if (group === "pane" && verb === "run") {
  if (!s.panes[target]) fail("pane_not_found", "pane " + target + " not found");
  s.panes[target].typed.push(args[3]); save(); out({ type: "ok" });
}
if (group === "pane" && verb === "get") {
  const p = s.panes[target];
  if (!p) fail("pane_not_found", "pane " + target + " not found");
  out({ type: "pane_info", pane: { pane_id: target, workspace_id: p.workspace, ...(p.agent_status ? { agent_status: p.agent_status } : {}) } });
}
if (group === "pane" && verb === "report-metadata") {
  if (!s.panes[target]) fail("pane_not_found", "pane " + target + " not found");
  s.panes[target].title = opt("--title"); save(); out({ type: "ok" });
}
if (group === "workspace" && verb === "close") {
  const found = Object.keys(s.panes).filter((p) => s.panes[p].workspace === target);
  if (found.length === 0) fail("workspace_not_found", "workspace " + target + " not found");
  for (const p of found) delete s.panes[p];
  save(); out({ type: "ok" });
}
fail("unsupported", "the stand-in herdr does not know: " + args.join(" "));
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as string[]),
    setAgentStatus: (pane, status) => {
      const s = JSON.parse(readFileSync(state, "utf8")) as { panes: Record<string, Record<string, unknown>> };
      const p = s.panes[pane];
      if (p) p.agent_status = status;
      writeFileSync(state, JSON.stringify(s));
    },
  };
}

export interface HerdrControlWorld {
  readonly control: HerdrControl;
  /** Makes herdr see an agent in the pane in this state (an agent's own detection, in real herdr). */
  setAgentStatus(pane: string, status: string): void;
}

/**
 * Every HerdrControl adapter passes this suite: a workspace opens with a pane, a command runs
 * there, the pane's agent status reads back, metadata is accepted, and a closed workspace's pane
 * reads as gone, not as an error.
 */
export function herdrControlContract(name: string, make: () => Promise<HerdrControlWorld>): void {
  describe(`HerdrControl contract: ${name}`, () => {
    test("open, run, status, report and close a run's workspace", async () => {
      const w = await make();
      const opened = (
        await w.control.open({
          cwd: "/tmp",
          label: "20261108-demo-x",
          env: { METATOR_RUN: "20261108-demo-x" },
        })
      )._unsafeUnwrap();
      expect(opened.workspace.length).toBeGreaterThan(0);
      expect(opened.pane.length).toBeGreaterThan(0);
      expect((await w.control.run(opened.pane, "echo hi")).isOk()).toBe(true);
      expect((await w.control.status(opened.pane))._unsafeUnwrap()).toEqual({ exists: true });
      w.setAgentStatus(opened.pane, "blocked");
      expect((await w.control.status(opened.pane))._unsafeUnwrap()).toEqual({
        exists: true,
        agentStatus: "blocked",
      });
      expect(
        (await w.control.report(opened.pane, { title: "build · working", tokens: { run: "x" } })).isOk(),
      ).toBe(true);
      expect((await w.control.close(opened.workspace)).isOk()).toBe(true);
      expect((await w.control.status(opened.pane))._unsafeUnwrap()).toEqual({ exists: false });
    }, 30_000);

    test("typing into a pane that is not there is an error, not a silent success", async () => {
      const w = await make();
      expect((await w.control.run("w99:p9", "echo hi")).isErr()).toBe(true);
    }, 30_000);
  });
}
