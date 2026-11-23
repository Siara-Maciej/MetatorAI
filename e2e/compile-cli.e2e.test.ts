import { describe, expect, test } from "bun:test";
import { sidecarTriples } from "../scripts/compile-cli.ts";

describe("compile-cli: the sidecars a Tauri build looks for", () => {
  test("one triple: its own sidecar", () => {
    expect(sidecarTriples("x86_64-pc-windows-msvc")).toEqual(["x86_64-pc-windows-msvc"]);
    expect(sidecarTriples("aarch64-apple-darwin")).toEqual(["aarch64-apple-darwin"]);
  });
  test("a universal macOS app is built once per architecture, each with its own sidecar, then joined", () => {
    expect(sidecarTriples("universal-apple-darwin")).toEqual([
      "universal-apple-darwin",
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
  });
});
