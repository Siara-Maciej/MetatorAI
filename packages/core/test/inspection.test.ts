import { describe, expect, test } from "bun:test";
import { defaultHost, loginFound, nextStep, schemaVersionOf, setUpState } from "../src/domain/inspection.ts";

describe("setUpState: set up, not yet, or by a newer MetatorAI", () => {
  test("no config is not set up; a config and the lock is; a config without the lock did not finish", () => {
    expect(setUpState(undefined, 1, true)).toBe("no");
    expect(setUpState(1, 1, true)).toBe("yes");
    expect(setUpState(1, 1, false)).toBe("no");
    expect(setUpState(0, 1, true)).toBe("yes");
  });

  test("a config newer than this MetatorAI reads is newer, lock or not", () => {
    expect(setUpState(2, 1, true)).toBe("newer");
    expect(setUpState(2, 1, false)).toBe("newer");
  });
});

describe("nextStep: what the app offers", () => {
  test("nothing there, then not a repository", () => {
    expect(nextStep("missing", [])).toBe("choose-another");
    expect(nextStep("not-git", [])).toBe("git-init");
  });

  test("a repository: setup, or just add it", () => {
    expect(nextStep("repo", [{ setUp: "no" }])).toBe("setup");
    expect(nextStep("repo", [{ setUp: "yes" }])).toBe("add");
    expect(nextStep("repo", [{ setUp: "newer" }])).toBe("update-app");
  });

  test("a folder: setup per repository while one is not, a newer one first says update", () => {
    expect(nextStep("folder", [{ setUp: "yes" }, { setUp: "no" }])).toBe("setup-repos");
    expect(nextStep("folder", [{ setUp: "yes" }, { setUp: "yes" }])).toBe("add");
    expect(nextStep("folder", [{ setUp: "no" }, { setUp: "newer" }])).toBe("update-app");
    expect(nextStep("folder", [])).toBe("add");
  });
});

describe("defaultHost: the first installed in the team's order", () => {
  const hosts = [
    { id: "claude" as const, installed: true },
    { id: "copilot" as const, installed: true },
  ];
  test("order decides among installed hosts; one not installed is skipped; none is null", () => {
    expect(defaultHost(["copilot", "claude"], hosts)).toBe("copilot");
    expect(defaultHost(["claude", "copilot"], hosts)).toBe("claude");
    expect(defaultHost(["copilot", "claude"], [{ id: "copilot", installed: false }, hosts[0] as never])).toBe(
      "claude",
    );
    expect(defaultHost(["copilot"], [{ id: "claude", installed: true }])).toBe("claude");
    expect(defaultHost(["copilot", "claude"], [{ id: "claude", installed: false }])).toBeNull();
  });
});

describe("loginFound: a sign of a login, never a guess", () => {
  const credentials = {
    env: ["ANTHROPIC_API_KEY"],
    files: [{ path: ".claude/.credentials.json" }, { path: ".claude.json", key: "oauthAccount" }],
  };
  // The adapter's reading: there or not, with its JSON when it is JSON.
  const files = (f: Record<string, string>) => (p: string) => {
    const text = f[p];
    if (text === undefined) return undefined;
    try {
      return { json: JSON.parse(text) as unknown };
    } catch {
      return { json: undefined };
    }
  };

  test("a credential variable with a value", () => {
    expect(loginFound(credentials, { ANTHROPIC_API_KEY: "sk-x" }, files({}))).toBe(true);
    expect(loginFound(credentials, { ANTHROPIC_API_KEY: " " }, files({}))).toBe(false);
    expect(loginFound(credentials, {}, files({}))).toBe(false);
  });

  test("a credentials file that is there; a file with a key only when the key holds something", () => {
    expect(loginFound(credentials, {}, files({ ".claude/.credentials.json": "{}" }))).toBe(true);
    expect(loginFound(credentials, {}, files({ ".claude.json": '{"oauthAccount":{"email":"a@b"}}' }))).toBe(
      true,
    );
    expect(loginFound(credentials, {}, files({ ".claude.json": '{"oauthAccount":{}}' }))).toBe(false);
    expect(loginFound(credentials, {}, files({ ".claude.json": '{"numStartups":3}' }))).toBe(false);
    expect(loginFound(credentials, {}, files({ ".claude.json": "not json" }))).toBe(false);
    const copilot = { env: [], files: [{ path: ".copilot/config.json", key: "logged_in_users" }] };
    expect(
      loginFound(copilot, {}, files({ ".copilot/config.json": '{"logged_in_users":[{"login":"me"}]}' })),
    ).toBe(true);
    expect(loginFound(copilot, {}, files({ ".copilot/config.json": '{"logged_in_users":[]}' }))).toBe(false);
    expect(loginFound(copilot, {}, files({ ".copilot/config.json": '{"logged_in_users":"me"}' }))).toBe(true);
  });
});

describe("schemaVersionOf", () => {
  test("an integer schemaVersion in the header, else none", () => {
    expect(schemaVersionOf({ kind: "MetatorConfig", schemaVersion: 2 })).toBe(2);
    expect(schemaVersionOf({ schemaVersion: "2" })).toBeUndefined();
    expect(schemaVersionOf({ schemaVersion: 1.5 })).toBeUndefined();
    expect(schemaVersionOf(null)).toBeUndefined();
    expect(schemaVersionOf("text")).toBeUndefined();
  });
});
