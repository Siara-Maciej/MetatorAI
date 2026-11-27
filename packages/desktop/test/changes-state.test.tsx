/**
 * The Changes tab's store (ADR-0113): a note on a line, on the file or on the whole change, the
 * notes sent as one message; and a diff line that draws again alone when a note opens on it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { StoreApi } from "zustand/vanilla";
import { Changes, type ChangesState } from "../src/features/runs/changes-state.ts";
import { DiffLineRow } from "../src/features/runs/changes-tab.tsx";
import type { DiffLine } from "../src/shared/api/api.ts";
import type { Daemon } from "../src/shared/daemon/daemon.tsx";
import type { Store } from "../src/shared/daemon/daemon-store.ts";
import { ScopeProvider, useScopedApi } from "../src/shared/state/scoped-store.ts";
import { counted, fakeDaemon, made } from "./screen-fakes.tsx";

const tab = (daemon: Store<Daemon>, file?: string): StoreApi<ChangesState> =>
  made(Changes.create({ daemon, runId: "r1", repo: "shop", file }));

describe("the Changes tab's state", () => {
  test("a blank note sends nothing; a note on a line names the file, the line and its side", async () => {
    const { daemon, calls } = fakeDaemon();
    const s = tab(daemon, "src/cart.ts");
    expect(await s.getState().add()).toBe(false);
    s.getState().openDraft({ line: 12, side: "old", text: "" });
    s.getState().writeDraft("  ");
    expect(await s.getState().add()).toBe(false);
    expect(calls.addNote).toBeUndefined();
    s.getState().writeDraft("why?");
    expect(await s.getState().add()).toBe(true);
    expect(calls.addNote?.[0]).toEqual([
      "r1",
      { text: "why?", by: "ana", file: "src/cart.ts", line: 12, side: "old" },
      "shop",
    ]);
    expect(s.getState().draft).toBeUndefined();
  });

  test("a note on the whole change names no file; the route's file is the one a note goes on", async () => {
    const { daemon, calls } = fakeDaemon();
    const s = tab(daemon);
    s.getState().openDraft({ text: "all good" });
    await s.getState().add();
    expect(calls.addNote?.[0]?.[1]).toEqual({ text: "all good", by: "ana" });
    s.getState().show("a.ts");
    s.getState().openDraft({ line: 3, text: "here" });
    await s.getState().add();
    expect(calls.addNote?.[1]?.[1]).toEqual({ text: "here", by: "ana", file: "a.ts", line: 3, side: "new" });
  });

  test("a refused note stays written, with why", async () => {
    const { daemon } = fakeDaemon({ addNote: { ok: false, error: { message: "gone" } } });
    const s = tab(daemon);
    s.getState().openDraft({ text: "x" });
    expect(await s.getState().add()).toBe(false);
    expect([s.getState().draft?.text, s.getState().notice?.text]).toEqual(["x", "gone"]);
    s.getState().closeNotice();
    expect(s.getState().notice).toBeUndefined();
  });

  test("Send to agent says how many went; a status changes without asking who", async () => {
    const { daemon, calls } = fakeDaemon();
    const s = tab(daemon);
    await s.getState().send(2);
    expect([calls.sendNotes?.[0], s.getState().notice]).toEqual([
      ["r1", "ana", "shop"],
      { text: "sent 2 notes to the run", tone: "info" },
    ]);
    await s.getState().setStatus({ id: "n1" } as never, "addressed");
    expect(calls.setNoteStatus?.[0]).toEqual(["r1", "n1", "addressed", "shop"]);
  });

  test("Cancel drops the draft; writing with no draft opens none", () => {
    const s = tab(fakeDaemon().daemon);
    s.getState().writeDraft("x");
    expect(s.getState().draft).toBeUndefined();
    s.getState().openDraft({ text: "" });
    s.getState().cancelDraft();
    expect(s.getState().draft).toBeUndefined();
  });
});

let grabbed: StoreApi<ChangesState> | undefined;
function Grab() {
  grabbed = useScopedApi(Changes);
  return null;
}

describe("the Changes tab's diff", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("a note opened on a line draws that line again; the focus moving draws the two lines", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { daemon } = fakeDaemon();
    const lines: DiffLine[] = [
      { kind: "ctx", old: 1, new: 1, text: "a" },
      { kind: "add", new: 2, text: "b" },
      { kind: "del", old: 2, text: "c" },
    ] as DiffLine[];
    const draws: Record<string, number> = {};
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        <ScopeProvider store={Changes} init={{ daemon, runId: "r1", repo: undefined, file: "a.ts" }}>
          <Grab />
          {[0, 1, 2].map((i) => (
            <div key={`row-${String(i)}`}>
              {counted(
                draws,
                `l${i}`,
                <DiffLineRow
                  id={`k${i}`}
                  first="k0"
                  l={lines[i] as DiffLine}
                  here={[]}
                  onOpenEditor={() => {}}
                />,
              )}
            </div>
          ))}
        </ScopeProvider>,
      ),
    );
    act(() => grabbed?.getState().openDraft({ line: 2, side: "new", text: "" }));
    expect(draws).toEqual({ l0: 1, l1: 2, l2: 1 });
    expect(host.querySelectorAll("textarea").length).toBe(1);
    act(() => grabbed?.getState().writeDraft("typed"));
    expect([draws.l0, draws.l2]).toEqual([1, 1]);
    act(() => grabbed?.getState().focusLine("k2"));
    expect([draws.l0, draws.l2]).toEqual([2, 2]);
    act(() => root.unmount());
  });
});
