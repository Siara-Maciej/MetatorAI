import { describe, expect, test } from "bun:test";
import { daemonRoute, inSandbox } from "../src/daemon-client.ts";

describe("reaching the daemon from inside the sandbox (ADR-0104)", () => {
  test("outside: directly, and the environment is left as it is", () => {
    const env: Record<string, string | undefined> = {
      HTTP_PROXY: "http://proxy:3128",
      NO_PROXY: "localhost",
    };
    expect(inSandbox(env)).toBe(false);
    expect(daemonRoute(env)).toEqual({});
    expect(env.NO_PROXY).toBe("localhost");
  });

  test("inside: through the sandbox's proxy, the only way out; its loopback exceptions are dropped", () => {
    const env: Record<string, string | undefined> = {
      METATOR_SANDBOX: "1",
      HTTP_PROXY: "http://srt.id@localhost:3128",
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost",
    };
    expect(inSandbox(env)).toBe(true);
    expect(daemonRoute(env)).toEqual({ proxy: "http://srt.id@localhost:3128" });
    expect([env.NO_PROXY, env.no_proxy]).toEqual([undefined, undefined]);
    expect(daemonRoute({ METATOR_SANDBOX: "1", http_proxy: "http://p:1" })).toEqual({ proxy: "http://p:1" });
    // A sandbox without a proxy (none was set up): nothing to route through.
    expect(daemonRoute({ METATOR_SANDBOX: "1" })).toEqual({});
  });
});
