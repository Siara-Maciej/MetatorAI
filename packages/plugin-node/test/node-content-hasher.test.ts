import { describe, expect, test } from "bun:test";
import { NodeContentHasher } from "../src/node-content-hasher.ts";

describe("NodeContentHasher", () => {
  test("the SHA-256 of the text as lowercase hex; one changed character changes it", () => {
    const hasher = new NodeContentHasher();
    expect(hasher.sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hasher.sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hasher.sha256("abd")).not.toBe(hasher.sha256("abc"));
    expect(hasher.sha256("zażółć")).toMatch(/^[0-9a-f]{64}$/);
  });
});
