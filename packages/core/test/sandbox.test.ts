import { describe, expect, test } from "bun:test";
import { MetatorConfigSchema } from "../src/domain/config.ts";
import { sandboxIsolation, sandboxPolicy } from "../src/domain/sandbox.ts";

describe("sandboxPolicy (ADR-0088): the repository's sandbox options as one policy", () => {
  test("off by default: no policy, nothing is generated", () => {
    expect(sandboxPolicy(MetatorConfigSchema.parse({}))).toBeUndefined();
    expect(
      sandboxPolicy(MetatorConfigSchema.parse({ options: { "sandbox.enabled": false } })),
    ).toBeUndefined();
  });

  test("on: home secrets unreadable by default, no extra hosts or folders, nothing runs outside", () => {
    expect(sandboxPolicy(MetatorConfigSchema.parse({ options: { "sandbox.enabled": true } }))).toEqual({
      denyRead: ["~/.ssh", "~/.aws", "~/.netrc"],
      allowWrite: [],
      allowedDomains: [],
      excludedCommands: [],
    });
  });

  test("the lists come from the options; a value an option refuses leaves its default", () => {
    const config = MetatorConfigSchema.parse({
      options: {
        "sandbox.enabled": true,
        "sandbox.denyRead": ["~/.ssh"],
        "sandbox.allowWrite": ["/tmp/build"],
        "sandbox.allowedDomains": ["registry.npmjs.org", "api.example.com"],
        "sandbox.excludedCommands": "not a list",
      },
    });
    expect(sandboxPolicy(config)).toEqual({
      denyRead: ["~/.ssh"],
      allowWrite: ["/tmp/build"],
      allowedDomains: ["registry.npmjs.org", "api.example.com"],
      excludedCommands: [],
    });
  });
});

describe("sandboxIsolation: what the machine needs for the policy to hold", () => {
  const on = sandboxPolicy(MetatorConfigSchema.parse({ options: { "sandbox.enabled": true } }));

  test("off is a warning with the two commands that turn it on", () => {
    const check = sandboxIsolation(undefined, "linux", []);
    expect([check.status, check.fix]).toEqual([
      "warn",
      "metator config set sandbox.enabled true --scope repo, then metator generate --hooks",
    ]);
    expect(check.message).toContain("can read every file you can");
  });

  test("on Linux it needs bubblewrap and socat; macOS has its own; Windows has none", () => {
    expect(sandboxIsolation(on, "linux", []).status).toBe("ok");
    const missing = sandboxIsolation(on, "linux", ["socat"]);
    expect([missing.status, missing.message]).toEqual([
      "warn",
      expect.stringContaining("socat is not installed"),
    ]);
    expect(missing.fix).toContain("bubblewrap socat");
    expect(sandboxIsolation(on, "darwin", ["bwrap", "socat"]).status).toBe("ok");
    const windows = sandboxIsolation(on, "win32", []);
    expect([windows.status, windows.message]).toEqual(["warn", expect.stringContaining("WSL2")]);
  });

  test("ok says what is and is not inside: the shell of Claude Code, not hooks, MCP servers or Copilot", () => {
    const message = sandboxIsolation(on, "linux", []).message;
    expect(message).toContain("Claude Code");
    expect(message).toContain("Copilot");
  });
});
