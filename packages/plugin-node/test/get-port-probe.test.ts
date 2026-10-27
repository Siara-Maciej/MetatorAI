import { expect, test } from "bun:test";
import { GetPortProbe } from "../src/get-port-probe.ts";

test("a port a server listens on is busy; after it stops, the port is free", async () => {
  const server = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
  const probe = new GetPortProbe();
  expect(await probe.isFree(server.port)).toBe(false);
  const port = server.port;
  server.stop(true);
  expect(await probe.isFree(port)).toBe(true);
});
