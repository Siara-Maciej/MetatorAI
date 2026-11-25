/**
 * What the window keeps of the person (src/shared/daemon/session.ts): the name asked once for
 * everyone who waits, each field under its own key of the window's storage, and the daemon the
 * app starts itself, tried once per folder until one answered.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/?daemon=http://127.0.0.1:4999/" });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("the session", () => {
  test("reads the address from the page, and keeps each field under its own key", async () => {
    localStorage.setItem("metator.repo", "shop");
    const s = await import("../src/shared/daemon/session.ts");
    expect(s.sessionStore().getState()).toMatchObject({
      url: "http://127.0.0.1:4999",
      savedRepo: "shop",
      me: "",
    });
    s.setUrl(" http://127.0.0.1:5000/ ");
    expect(localStorage.getItem("metator.daemon")).toBe("http://127.0.0.1:5000");
    s.setRepo("web");
    expect(localStorage.getItem("metator.repo")).toBe("web");
    s.markSeen({ runId: "r1", repo: "web" });
    expect(Object.keys(JSON.parse(localStorage.getItem("metator.seen") ?? "{}"))).toHaveLength(1);
  });

  test("the name is asked once, and everyone who asked gets it", async () => {
    const s = await import("../src/shared/daemon/session.ts");
    const first = s.who();
    const second = s.who();
    expect(s.sessionStore().getState().asking).toBe(true);
    s.settleName("ana");
    expect(await Promise.all([first, second])).toEqual(["ana", "ana"]);
    expect(s.sessionStore().getState()).toMatchObject({ me: "ana", asking: false });
    expect(localStorage.getItem("metator.me")).toBe("ana");
    // Known now: nobody is asked again.
    expect(await s.who()).toBe("ana");
    expect(s.sessionStore().getState().asking).toBe(false);
  });

  test("a cancelled dialog answers everyone with no name and keeps none", async () => {
    const s = await import("../src/shared/daemon/session.ts");
    s.setMe("");
    const asked = s.who();
    s.settleName("");
    expect(await asked).toBe("");
    expect(s.sessionStore().getState().me).toBe("");
  });

  test("in a browser there is no shell: nothing is started", async () => {
    const s = await import("../src/shared/daemon/session.ts");
    expect(s.sessionShell()).toBeUndefined();
    expect(await s.start("/work/shop")).toBe("no folder to start the daemon in");
    s.daemonAnswered(false, true);
    expect(s.sessionStore().getState().starting).toBe(false);
  });
});
