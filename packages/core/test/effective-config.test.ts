import { describe, expect, test } from "bun:test";
import { MetatorConfigSchema } from "../src/domain/config.ts";
import { withRepoOptions } from "../src/domain/effective-config.ts";

describe("the repository's options over the fields they replaced", () => {
  test("a supervisor option wins over the `supervisor` field; an option the file does not set leaves it", () => {
    const config = MetatorConfigSchema.parse({
      supervisor: { wipLimit: 7, hostOrder: ["claude"] },
      options: {
        "supervisor.wipLimit": 2,
        "supervisor.respawn": false,
        "supervisor.respawnAttempts": 5,
        "supervisor.idleThresholdMs": 5000,
      },
    });
    expect(withRepoOptions(config).supervisor).toEqual({
      wipLimit: 2,
      respawn: { enabled: false, maxAttempts: 5 },
      idleThresholdMs: 5000,
      hostOrder: ["claude"],
      chatApprovals: "attached-only",
    });
    const order = MetatorConfigSchema.parse({ options: { "supervisor.hostOrder": ["claude", "copilot"] } });
    expect(withRepoOptions(order).supervisor.hostOrder).toEqual(["claude", "copilot"]);
    // Nothing set: the configuration is what it was.
    const plain = MetatorConfigSchema.parse({ supervisor: { wipLimit: 7 } });
    expect(withRepoOptions(plain)).toEqual(plain);
  });

  test("a value the option refuses leaves the field (the refusal is a diagnostic of `config list`)", () => {
    const config = MetatorConfigSchema.parse({
      supervisor: { wipLimit: 7 },
      options: { "supervisor.wipLimit": 0 },
    });
    expect(withRepoOptions(config).supervisor.wipLimit).toBe(7);
  });

  test("notify.command as an option replaces the `notify` field; empty turns the command off", () => {
    const legacy = MetatorConfigSchema.parse({ notify: { command: "old" } });
    expect(withRepoOptions(legacy).notify).toEqual({ command: "old" });
    const set = MetatorConfigSchema.parse({
      notify: { command: "old" },
      options: { "notify.command": "new" },
    });
    expect(withRepoOptions(set).notify).toEqual({ command: "new" });
    const off = MetatorConfigSchema.parse({ notify: { command: "old" }, options: { "notify.command": "" } });
    expect(withRepoOptions(off).notify).toBeUndefined();
    expect(withRepoOptions(MetatorConfigSchema.parse({})).notify).toBeUndefined();
  });
});
