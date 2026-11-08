import { describe, expect, test } from "bun:test";
import { workspaceOf } from "../src/commands/herdr.ts";

describe("workspaceOf", () => {
  test("herdr's workspace id first, then the pane's, then the event's pane", () => {
    expect(workspaceOf({ HERDR_WORKSPACE_ID: "w2", HERDR_PANE_ID: "w9:p1" })).toBe("w2");
    expect(workspaceOf({ HERDR_PANE_ID: "w3:p2" })).toBe("w3");
    expect(
      workspaceOf({ HERDR_PLUGIN_EVENT_JSON: '{"type":"pane.agent_status_changed","pane_id":"w4:p1"}' }),
    ).toBe("w4");
    expect(workspaceOf({ HERDR_PLUGIN_EVENT_JSON: '{"pane":{"pane_id":"w5:p3"}}' })).toBe("w5");
    expect(workspaceOf({ HERDR_PLUGIN_EVENT_JSON: "not json" })).toBeUndefined();
    expect(workspaceOf({})).toBeUndefined();
  });
});
