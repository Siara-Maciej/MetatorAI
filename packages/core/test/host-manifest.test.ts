import { describe, expect, test } from "bun:test";
import {
  BUILTIN_MANIFESTS,
  genericManifest,
  HostManifestDocument,
  HostManifestSchema,
  hostPromptText,
  paneStateOf,
} from "../src/domain/host-manifest.ts";

const copilot = HostManifestSchema.parse(BUILTIN_MANIFESTS.find((m) => m.host === "copilot"));
const scenario = HostManifestSchema.parse(BUILTIN_MANIFESTS.find((m) => m.host === "scenario"));
const T0 = new Date("2026-11-09T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const base = { alive: true, manifest: copilot, lastOutputAt: T0, openQuestion: false };

describe("HostManifest", () => {
  test("every built-in manifest is a valid v1 document with valid patterns; the generic one reads only quiet and exit", () => {
    for (const m of BUILTIN_MANIFESTS) {
      const parsed = HostManifestDocument.parse({ kind: "HostManifest", schemaVersion: 1, ...m }, m.host);
      expect([m.host, parsed.isOk()]).toEqual([m.host, true]);
    }
    expect(BUILTIN_MANIFESTS.map((m) => m.host)).toEqual(["copilot", "claude", "opencode", "scenario"]);
    expect(genericManifest("other")).toEqual({
      host: "other",
      screen: { blocked: [], idle: [], lines: 6 },
      quietMs: 15_000,
      hooks: true,
    });
    const bad = HostManifestSchema.safeParse({ host: "x", screen: { blocked: ["("] } });
    expect(bad.success).toBe(false);
    expect(HostManifestSchema.safeParse({ host: "Bad Host" }).success).toBe(false);
  });

  test("the state in order of certainty: exit, the host's prompt, an open question, recent output or hook, quiet", () => {
    expect(paneStateOf({ ...base, alive: false, exitCode: 3, screen: "", now: T0 })).toEqual({
      state: "exited",
      reason: "exited with 3",
    });
    const blocked = paneStateOf({
      ...base,
      screen: "running tests\n\x1b[1m\nAllow copilot to run `bun test`? (y/n)\n",
      now: at(100),
    });
    expect(blocked).toEqual({ state: "blocked", reason: "Allow copilot to run `bun test`? (y/n)" });
    expect(paneStateOf({ ...base, screen: "thinking…", now: at(100), openQuestion: true })).toEqual({
      state: "waiting",
      reason: "a question waits for a person",
    });
    expect(paneStateOf({ ...base, screen: "thinking…", now: at(100) })).toEqual({
      state: "working",
      reason: "output just now",
    });
    expect(paneStateOf({ ...base, screen: "thinking…", now: at(20_000), lastHookAt: at(19_000) })).toEqual({
      state: "working",
      reason: "a hook call just now",
    });
    expect(paneStateOf({ ...base, screen: "done.", now: at(20_000) })).toEqual({
      state: "idle",
      reason: "quiet for 20 s",
    });
    // The host's own prompt is idle once the screen settled, however recent the output.
    expect(paneStateOf({ ...base, screen: "done.\n> ", now: at(1_500) })).toEqual({
      state: "idle",
      reason: ">",
    });
    expect(paneStateOf({ ...base, screen: "done.\n> ", now: at(200) }).state).toBe("working");
    // A pattern far up the screen does not count: only the last `lines` lines are read.
    const old = `Allow x to run? (y/n)\n${Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n")}`;
    expect(paneStateOf({ ...base, screen: old, now: at(100) }).state).toBe("working");
  });

  test("the scenario host's question line is its prompt; the inbox text names host, pane and line", () => {
    const s = paneStateOf({
      ...base,
      manifest: scenario,
      screen: "first session\nGo on? [yes / no]\n",
      now: at(100),
    });
    expect(s).toEqual({ state: "blocked", reason: "Go on? [yes / no]" });
    expect(hostPromptText("copilot", "w1:p1", "Allow? (y/n)")).toBe(
      "copilot waits for your answer in pane w1:p1: Allow? (y/n)",
    );
  });
});
