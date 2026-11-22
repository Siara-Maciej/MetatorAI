import { describe, expect, test } from "bun:test";
import { checkoutRoots, err, MetatorError, ok, workNotes } from "@metator/core";
import { InMemoryCheckouts, InMemoryFileSystem } from "@metator/testing";

const at = (files: Record<string, string>, installed = false) =>
  new InMemoryCheckouts({
    "/work": new InMemoryFileSystem(files),
    ...(installed ? { "/work/node_modules": new InMemoryFileSystem({}) } : {}),
  });

describe("workNotes", () => {
  test("a Node project without node_modules is told its tools cannot run", async () => {
    const notes = await workNotes(at({ "package.json": '{"devDependencies":{"vitest":"3"}}' }), "/work");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("dependencies are not installed here (no node_modules)");
    expect(notes[0]).toContain("Do not install anything");
  });

  test("an installed project, one with nothing to install, and a directory that is no Node project get no note", async () => {
    expect(await workNotes(at({ "package.json": '{"dependencies":{"a":"1"}}' }, true), "/work")).toEqual([]);
    // Nothing to install: no node_modules is not a missing install (F5).
    expect(await workNotes(at({ "package.json": "{}" }), "/work")).toEqual([]);
    expect(await workNotes(at({ "README.md": "x" }), "/work")).toEqual([]);
  });

  test("the directory may end with a slash", async () => {
    expect(await workNotes(at({ "package.json": '{"dependencies":{"a":"1"}}' }, true), "/work")).toEqual([]);
    const checkouts = {
      read: async () => ok('{"dependencies":{"a":"1"}}'),
      isDirectory: async (path: string) => path === "/work/node_modules",
    };
    expect(await workNotes(checkouts, "/work/")).toEqual([]);
  });

  test("a manifest that cannot be read adds no note", async () => {
    const checkouts = {
      read: async () => err(MetatorError.usage("outside")),
      isDirectory: async () => false,
    };
    expect(await workNotes(checkouts, "/work")).toEqual([]);
  });
});

describe("checkoutRoots", () => {
  test("the checkouts the map's applications are in; one not on this machine, or no map, adds none", async () => {
    const apps = [{ id: "api" }, { id: "web" }, { id: "gone" }];
    const roots: Record<string, string> = { api: "/f/api", web: "/f/front" };
    const sources = {
      location: { require: async () => ok({ applications: apps }) },
      locate: async (app: { id: string }) =>
        ok(roots[app.id] ? { app: app.id, root: roots[app.id], dir: ".", via: "local" } : undefined),
    } as unknown as Parameters<typeof checkoutRoots>[0];
    expect(await checkoutRoots(sources)).toEqual(["/f/api", "/f/front"]);
    const none = {
      location: { require: async () => err(new MetatorError("NOT_FOUND", "no map")) },
      locate: async () => ok(undefined),
    } as unknown as Parameters<typeof checkoutRoots>[0];
    expect(await checkoutRoots(none)).toEqual([]);
  });
});
