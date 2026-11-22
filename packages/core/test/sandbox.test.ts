import { describe, expect, test } from "bun:test";
import { sandboxLaunch, UNSANDBOXED } from "../src/application/host-descriptors.ts";
import { MetatorConfigSchema } from "../src/domain/config.ts";
import { MetatorError } from "../src/domain/errors.ts";
import { err, ok } from "../src/domain/result.ts";
import {
  daemonAddress,
  sandboxIsolation,
  sandboxPolicy,
  sandboxSettings,
  sandboxUnavailable,
} from "../src/domain/sandbox.ts";

describe("sandboxPolicy (ADR-0102, ADR-0104): the repository's sandbox options as one policy", () => {
  test("off by default: no policy, every session starts as it is", () => {
    expect(sandboxPolicy(MetatorConfigSchema.parse({}))).toBeUndefined();
    expect(
      sandboxPolicy(MetatorConfigSchema.parse({ options: { "sandbox.enabled": false } })),
    ).toBeUndefined();
  });

  test("on: home secrets unreadable by default, no extra hosts or folders", () => {
    expect(sandboxPolicy(MetatorConfigSchema.parse({ options: { "sandbox.enabled": true } }))).toEqual({
      denyRead: ["~/.ssh", "~/.aws", "~/.netrc"],
      allowWrite: [],
      allowedDomains: [],
    });
  });

  test("the lists come from the options; a value an option refuses leaves its default", () => {
    const config = MetatorConfigSchema.parse({
      options: {
        "sandbox.enabled": true,
        "sandbox.denyRead": "not a list",
        "sandbox.allowWrite": ["/tmp/build"],
        "sandbox.allowedDomains": ["registry.npmjs.org", "api.example.com"],
      },
    });
    expect(sandboxPolicy(config)).toEqual({
      denyRead: ["~/.ssh", "~/.aws", "~/.netrc"],
      allowWrite: ["/tmp/build"],
      allowedDomains: ["registry.npmjs.org", "api.example.com"],
    });
  });
});

describe("sandboxSettings: one policy, the host's needs, the session's place", () => {
  const policy = { denyRead: ["~/.ssh"], allowWrite: ["/opt/cache"], allowedDomains: ["registry.npmjs.org"] };
  const place = { root: "/repo", cwd: "/repo/.metator/wt/r1", temp: "/tmp" };

  test("the host's API and the daemon are reachable; the repository's secrets are not readable", () => {
    const s = sandboxSettings(
      policy,
      { domains: ["api.githubcopilot.com", "github.com"], writable: ["~/.copilot"] },
      { ...place, daemon: "127.0.0.1:4310" },
    );
    expect(s.network).toEqual({
      allowedDomains: ["api.githubcopilot.com", "github.com", "registry.npmjs.org", "127.0.0.1:4310"],
      deniedDomains: [],
    });
    expect(s.filesystem.denyRead).toEqual(
      expect.arrayContaining(["~/.ssh", "**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*"]),
    );
    expect(s.filesystem.denyRead.some((p) => p.startsWith("!"))).toBe(false);
    expect(s.filesystem.allowRead).toEqual(["**/.env.example", "**/.env.sample"]);
    expect(s.filesystem.allowWrite).toEqual([
      "/repo",
      "/repo/.metator/wt/r1",
      "/tmp",
      "~/.copilot",
      "/opt/cache",
    ]);
    expect(s.filesystem.denyWrite).toEqual([]);
  });

  test("the same policy gives both hosts the same files and lists, only their own needs differ", () => {
    const claude = sandboxSettings(
      policy,
      { domains: ["api.anthropic.com"], writable: ["~/.claude"] },
      place,
    );
    const copilot = sandboxSettings(
      policy,
      { domains: ["api.githubcopilot.com"], writable: ["~/.copilot"] },
      place,
    );
    expect(claude.filesystem.denyRead).toEqual(copilot.filesystem.denyRead);
    expect(claude.network.allowedDomains.filter((d) => d !== "api.anthropic.com")).toEqual(
      copilot.network.allowedDomains.filter((d) => d !== "api.githubcopilot.com"),
    );
    // Without a daemon nothing local is reachable; a repeated entry is listed once.
    expect(claude.network.allowedDomains).toEqual(["api.anthropic.com", "registry.npmjs.org"]);
    const twice = sandboxSettings(policy, { domains: [], writable: [] }, { ...place, cwd: "/repo" });
    expect(twice.filesystem.allowWrite).toEqual(["/repo", "/tmp", "/opt/cache"]);
  });

  test("the daemon's address as an IP literal with its port", () => {
    expect(daemonAddress("http://127.0.0.1:4310")).toBe("127.0.0.1:4310");
    expect(daemonAddress("http://localhost:5000/")).toBe("127.0.0.1:5000");
    expect(daemonAddress("http://[::1]:7000")).toBe("[::1]:7000");
    expect(daemonAddress("not a url")).toBeUndefined();
  });
});

describe("sandboxLaunch: how a host's program starts", () => {
  const sandbox = {
    calls: [] as unknown[],
    command(argv: readonly string[], settings: unknown) {
      this.calls.push(settings);
      return ok(["srt", "--", ...argv]);
    },
  };
  const base = {
    needs: { domains: ["api.anthropic.com"], writable: [] },
    root: "/repo",
    temp: "/tmp",
    daemon: () => "127.0.0.1:4310",
    sandbox,
  };

  test("off: as given; on: through the sandbox, with the policy as it is at that start", () => {
    let on = false;
    const launch = sandboxLaunch({
      ...base,
      policy: () => (on ? { denyRead: [], allowWrite: [], allowedDomains: [] } : undefined),
    });
    expect(launch(["claude", "hi"], "/repo")._unsafeUnwrap()).toEqual({
      argv: ["claude", "hi"],
      sandboxed: false,
    });
    on = true;
    expect(launch(["claude", "hi"], "/repo/wt")._unsafeUnwrap()).toEqual({
      argv: ["srt", "--", "claude", "hi"],
      sandboxed: true,
    });
    expect(sandbox.calls.at(-1)).toMatchObject({
      network: { allowedDomains: ["api.anthropic.com", "127.0.0.1:4310"] },
      filesystem: { allowWrite: ["/repo", "/repo/wt", "/tmp"] },
    });
    expect(UNSANDBOXED(["copilot"], "/r")._unsafeUnwrap()).toEqual({ argv: ["copilot"], sandboxed: false });
  });

  test("a sandbox that cannot be prepared starts nothing: its error is the launch's", () => {
    const launch = sandboxLaunch({
      ...base,
      policy: () => ({ denyRead: [], allowWrite: [], allowedDomains: [] }),
      sandbox: { command: () => err(new MetatorError("COMMAND_FAILED", "no srt")) },
    });
    expect(launch(["copilot"], "/repo")._unsafeUnwrapErr().message).toBe("no srt");
  });
});

describe("sandboxIsolation: what the machine needs for the policy to hold", () => {
  const on = sandboxPolicy(MetatorConfigSchema.parse({ options: { "sandbox.enabled": true } }));

  test("off is a warning with the command that turns it on", () => {
    const check = sandboxIsolation(undefined, "linux", []);
    expect([check.status, check.fix]).toEqual([
      "warn",
      "metator config set sandbox.enabled true --scope repo",
    ]);
    expect(check.message).toContain("can read every file you can");
  });

  test("on Linux it needs bubblewrap, socat and ripgrep; macOS has its own; native Windows has none", () => {
    expect(sandboxIsolation(on, "linux", []).status).toBe("ok");
    const missing = sandboxIsolation(on, "linux", ["socat", "rg"]);
    expect([missing.status, missing.message]).toEqual([
      "warn",
      expect.stringContaining("socat, rg is not installed"),
    ]);
    expect(missing.fix).toContain("bubblewrap socat ripgrep");
    expect(sandboxIsolation(on, "darwin", ["bwrap", "socat"]).status).toBe("ok");
    const windows = sandboxIsolation(on, "win32", []);
    expect([windows.status, windows.message]).toEqual(["warn", expect.stringContaining("WSL2")]);
  });

  test("ok says both hosts' sessions are inside, and a host started by hand is not", () => {
    const message = sandboxIsolation(on, "linux", []).message;
    expect(message).toContain("Claude Code and Copilot CLI");
    expect(message).toContain("start by hand does not");
  });

  test("whether the machine can hold one at all, for the conformance check", () => {
    expect(sandboxUnavailable("linux", [])).toBeUndefined();
    expect(sandboxUnavailable("darwin", ["bwrap"])).toBeUndefined();
    expect(sandboxUnavailable("linux", ["bwrap"])).toBe("bwrap is not installed");
    expect(sandboxUnavailable("win32", [])).toContain("WSL2");
    expect(sandboxUnavailable("freebsd", [])).toBe("freebsd has no sandbox here");
  });
});
