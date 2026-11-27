/**
 * The document editor's store (ADR-0113): editing as fields or text, the check, the summary before
 * a save, a save over an old version; and a row of the system map's form that draws again alone.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { StoreApi } from "zustand/vanilla";
import {
  DocEdit,
  type DocEditState,
  type DocSource,
  dirtyOf,
} from "../src/features/plans/doc-editor-state.ts";
import { AppRow, SystemNameField } from "../src/features/system/system-map-editor.tsx";
import { SystemMapScreen } from "../src/features/system/system-map-state.ts";
import { LinksAction, SystemChoice } from "../src/features/system/system-state.ts";
import { ScopeProvider, useScopedApi } from "../src/shared/state/scoped-store.ts";
import { counted, fakeDaemon, made } from "./screen-fakes.tsx";

interface Doc {
  readonly name: string;
}
interface View {
  readonly doc: Doc | null;
  readonly digest: string;
}

const view = (name: string | null, digest = "d1"): View => ({ doc: name === null ? null : { name }, digest });

function source(over: Partial<DocSource<View, Doc>> = {}): DocSource<View, Doc> {
  return {
    reload: mock(async () => undefined),
    docOf: (v) => v.doc,
    digestOf: (v) => v.digest,
    lintOf: () => ({ problems: [] }),
    editable: () => true,
    readOnlyBecause: () => undefined,
    save: async () => ({ ok: true }),
    changes: (a, b) => (a.name === b.name ? [] : [`renamed to ${b.name}`]),
    ...over,
  };
}

const editor = (src: DocSource<View, Doc>): StoreApi<DocEditState> =>
  made(
    DocEdit.create({ source: src as unknown as DocSource<unknown, unknown>, daemon: fakeDaemon().daemon }),
  );

describe("the document editor's state", () => {
  test("nothing to edit without a view, or without a document and a blank one", () => {
    const s = editor(source());
    s.getState().edit("form", undefined);
    s.getState().edit("form", view(null));
    expect(s.getState().mode).toBe("view");
    const blank = editor(source({ blank: () => ({ name: "new" }) }));
    blank.getState().edit("form", view(null));
    expect([blank.getState().mode, blank.getState().draft, blank.getState().base]).toEqual([
      "form",
      { name: "new" },
      { doc: null, digest: "d1" },
    ]);
  });

  test("fields and text follow each other; a text that does not parse stays, with why", () => {
    const s = editor(source());
    s.getState().edit("form", view("shop"));
    expect(dirtyOf(s.getState())).toBe(false);
    s.getState().setDraft<Doc>((d) => ({ ...d, name: "cart" }));
    expect(dirtyOf(s.getState())).toBe(true);
    s.getState().edit("text", view("shop"));
    expect([s.getState().mode, JSON.parse(s.getState().text)]).toEqual(["text", { name: "cart" }]);
    s.getState().setText("{ not json");
    s.getState().edit("form", view("shop"));
    expect([s.getState().mode, s.getState().checked?.length]).toEqual(["text", 1]);
    s.getState().setText('{ "name": "pay" }');
    s.getState().edit("form", view("shop"));
    expect([s.getState().mode, s.getState().draft, s.getState().checked]).toEqual([
      "form",
      { name: "pay" },
      undefined,
    ]);
    s.getState().cancel();
    expect([s.getState().mode, s.getState().draft, dirtyOf(s.getState())]).toEqual([
      "view",
      undefined,
      false,
    ]);
  });

  test("Save… says what changes first; an edit drops the summary", () => {
    const s = editor(source());
    s.getState().edit("form", view("shop"));
    s.getState().review();
    expect(s.getState().pending).toEqual(["nothing changed"]);
    s.getState().setDraft<Doc>(() => ({ name: "cart" }));
    expect(s.getState().pending).toBeUndefined();
    s.getState().review();
    expect(s.getState().pending).toEqual(["renamed to cart"]);
  });

  test("Check with no check of the daemon finds nothing; a refused check says why", async () => {
    const s = editor(source());
    s.getState().edit("form", view("shop"));
    await s.getState().check();
    expect(s.getState().checked).toEqual([]);
    const refused = editor(
      source({ check: async () => ({ ok: false, error: { code: "X", message: "down" } }) }),
    );
    refused.getState().edit("form", view("shop"));
    await refused.getState().check();
    expect([refused.getState().checked, refused.getState().notice?.text, refused.getState().busy]).toEqual([
      undefined,
      "down",
      false,
    ]);
  });

  test("a save names the digest it was read at, closes the editor and reads the document again", async () => {
    const save = mock(async () => ({ ok: true }));
    const src = source({ save });
    const s = editor(src);
    s.getState().edit("form", view("shop", "d7"));
    await s.getState().save();
    expect(save.mock.calls[0]).toEqual([{ name: "shop" }, "d7", "ana"] as never);
    expect([s.getState().mode, s.getState().notice]).toEqual([
      "view",
      { text: "Saved by ana.", tone: "info" },
    ]);
    expect((src.reload as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });

  test("a save on an old version shows what is there now; Keep my edits saves over it", async () => {
    const theirs = view("theirs", "d9");
    const save = mock(async () => ({
      ok: false,
      error: { code: "CONFLICT", message: "changed", details: { current: theirs } },
    }));
    const s = editor(source({ save }));
    s.getState().edit("form", view("shop", "d1"));
    s.getState().review();
    await s.getState().save();
    expect([s.getState().conflict, s.getState().pending]).toEqual([theirs, undefined]);
    s.getState().keepMine();
    expect([s.getState().conflict, s.getState().base]).toEqual([
      undefined,
      { doc: { name: "theirs" }, digest: "d9" },
    ]);
    await s.getState().save();
    expect((save.mock.calls as unknown[][])[1]?.[1]).toBe("d9");
  });

  test("a refused save keeps the editor open with its problems", async () => {
    const problem = { severity: "error" as const, message: "no name", code: "P1" };
    const s = editor(
      source({
        save: async () => ({
          ok: false,
          error: { code: "INVALID", message: "bad", details: { problems: [problem] } },
        }),
      }),
    );
    s.getState().edit("form", view("shop"));
    await s.getState().save();
    expect([s.getState().mode, s.getState().checked, s.getState().notice?.text]).toEqual([
      "form",
      [problem],
      "bad",
    ]);
  });
});

let grabbed: StoreApi<DocEditState> | undefined;
function Grab() {
  grabbed = useScopedApi(DocEdit);
  return null;
}

describe("the system map's form", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("typing in an application's field draws that row again, not the other rows", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const map = {
      system: "shop",
      applications: [
        { id: "web", kind: "frontend", source: { path: "web" } },
        { id: "api", kind: "service", source: { path: "api" } },
      ],
      contracts: [],
    };
    const mapView = { map, digest: "d1" };
    const src = {
      ...source(),
      docOf: (v: typeof mapView) => v.map,
    } as unknown as DocSource<unknown, unknown>;
    const draws: Record<string, number> = {};
    const root = createRoot(document.createElement("div"));
    act(() =>
      root.render(
        <ScopeProvider store={DocEdit} init={{ source: src, daemon: fakeDaemon().daemon }}>
          <Grab />
          {counted(draws, "name", <SystemNameField />)}
          {counted(draws, "web", <AppRow i={0} />)}
          {counted(draws, "api", <AppRow i={1} />)}
        </ScopeProvider>,
      ),
    );
    act(() => grabbed?.getState().edit("form", mapView));
    expect(draws).toEqual({ name: 2, web: 2, api: 2 });
    const rename = (id: string) =>
      grabbed?.getState().setDraft<typeof map>((m) => ({
        ...m,
        applications: m.applications.map((a, j) => (j === 0 ? { ...a, id } : a)),
      }));
    act(() => rename("w"));
    act(() => rename("we"));
    expect(draws).toEqual({ name: 2, web: 4, api: 2 });
    act(() => root.unmount());
  });
});

describe("the System map screen's state", () => {
  const screen = (answers: Record<string, unknown>) => {
    const reloadOptions = mock(async () => undefined);
    const { daemon, calls } = fakeDaemon(answers, { reloadOptions });
    return { s: made(SystemMapScreen.create({ daemon })), calls, reloadOptions };
  };

  test("Discover shows what it found; Write the map asks who, writes, and forgets it", async () => {
    const found = { changes: ["add web"], proposed: {} };
    const { s, calls } = screen({ discover: { ok: true, data: found } });
    expect(await s.getState().discover(false)).toBe(true);
    expect([calls.discover?.[0]?.[0], s.getState().found]).toEqual([{ write: false }, found]);
    await s.getState().discover(true);
    expect([calls.discover?.[1]?.[0], s.getState().found]).toEqual([{ write: true, by: "ana" }, undefined]);
    expect(s.getState().notice).toEqual({ text: "the map is written", tone: "info" });
  });

  test("the roots are saved trimmed in the option's scope; the draft goes, the options are read again", async () => {
    const { s, calls, reloadOptions } = screen({});
    s.getState().editRoots([" /code ", "/src"]);
    expect(await s.getState().saveRoots(s.getState().rootsDraft ?? [], "user")).toBe(true);
    expect(calls.setOption?.[0]).toEqual([
      "system.roots",
      { scope: "user", value: ["/code", "/src"] },
      "shop",
    ]);
    expect([s.getState().rootsDraft, reloadOptions.mock.calls.length]).toEqual([undefined, 1]);
  });

  test("refused roots stay as typed", async () => {
    const { s } = screen({ setOption: { ok: false, error: { message: "no" } } });
    s.getState().editRoots(["x"]);
    expect(await s.getState().saveRoots(["x"], "repo")).toBe(false);
    expect([s.getState().rootsDraft, s.getState().notice?.text]).toEqual([["x"], "no"]);
    s.getState().cancelRoots();
    expect(s.getState().rootsDraft).toBeUndefined();
  });

  test("the System part's choice, and the Dependencies panel's notice until closed", () => {
    const choice = made(SystemChoice.create(undefined));
    choice.getState().choose("map");
    expect(choice.getState().chosen).toBe("map");
    const links = made(LinksAction.create(undefined));
    links.setState({ notice: { text: "both runs were told", tone: "info" } });
    links.getState().closeNotice();
    expect(links.getState().notice).toBeUndefined();
  });
});
