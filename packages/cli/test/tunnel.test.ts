import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { tunnel } from "../src/tunnel.ts";

/** A tunnel's ends as streams a test writes and reads. */
function ends() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (c: Buffer) => chunks.push(c));
  return { input, output, text: () => Buffer.concat(chunks).toString() };
}

describe("tunnel", () => {
  test("bytes go both ways; the end of the connection ends it with everything written out", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          socket.write(`echo:${chunk.toString()}`);
          if (chunk.toString().includes("bye")) socket.end();
        },
      },
    });
    const e = ends();
    const done = tunnel({ port: server.port, host: "127.0.0.1" }, e);
    e.input.write("hi");
    await Bun.sleep(100);
    e.input.write("bye");
    expect((await done)._unsafeUnwrap()).toEqual({ sent: 5, received: 15 });
    expect(e.text()).toBe("echo:hiecho:bye");
    server.stop(true);
  });

  test("the end of stdin waits for a slow answer, then ends the connection once the server is quiet", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await Bun.sleep(300);
        return new Response("slow answer");
      },
    });
    const e = ends();
    const started = performance.now();
    const done = tunnel({ port: server.port as number, host: "127.0.0.1", quietMs: 600 }, e);
    e.input.end("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    (await done)._unsafeUnwrap();
    expect(e.text()).toContain("slow answer");
    // A keep-alive connection: ended by the quiet time after the answer, not by the server.
    expect(performance.now() - started).toBeGreaterThan(800);
    server.stop(true);
  });

  test("it ends only once a slow output has written everything it received", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.write("one;");
          socket.write("two;");
          socket.end("three");
        },
        data() {},
      },
    });
    const written: string[] = [];
    const output = new Writable({
      write(chunk: Buffer, _enc, done) {
        setTimeout(() => {
          written.push(chunk.toString());
          done();
        }, 50);
      },
    });
    const r = await tunnel(
      { port: server.port as number, host: "127.0.0.1" },
      { input: new PassThrough(), output },
    );
    expect(r.isOk()).toBe(true);
    expect(written.join("")).toBe("one;two;three");
    server.stop(true);
  });

  test("nothing listening is an error that says where", async () => {
    const e = ends();
    const r = (await tunnel({ port: 1, host: "127.0.0.1" }, e))._unsafeUnwrapErr();
    expect([r.code, r.message.startsWith("nothing listens on 127.0.0.1:1")]).toEqual([
      "COMMAND_FAILED",
      true,
    ]);
  });
});
