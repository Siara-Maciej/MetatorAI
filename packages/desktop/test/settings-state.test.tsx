/**
 * Settings' store (ADR-0113): a section clears the search, a refused change is counted for its
 * own option only, the options are read again either way; a row draws again only when its own
 * option changed; writing the app's metator path draws the path field again, not the page.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createStore, type StoreApi } from "zustand/vanilla";
import { CliInfoLine, CustomPath } from "../src/features/settings/app-settings.tsx";
import { OptionRow } from "../src/features/settings/settings-screen.tsx";
import { conflictsOf, shownKeys } from "../src/features/settings/shown.ts";
import {
  type AppSettingsState,
  AppSettingsStore,
  Settings,
  type SettingsState,
} from "../src/features/settings/state.ts";
import type { ResolvedOption } from "../src/shared/api/api.ts";
import { publish } from "../src/shared/daemon/daemon-store.ts";
import type { Commands } from "../src/shared/platform/tauri-commands.ts";
import { ScopeProvider, useScopedApi } from "../src/shared/state/scoped-store.ts";
import { counted, drawRoot, fakeDaemon } from "./screen-kit.tsx";

const option = (key: string, value: unknown, over: Record<string, unknown> = {}): ResolvedOption =>
  ({
    key,
    value,
    source: "default",
    layers: {},
    definition: {
      key,
      scope: "user",
      kind: "string",
      title: key,
      description: `about ${key}`,
      restart: "none",
      ...over,
    },
  }) as never;

const view = (options: readonly ResolvedOption[]) => ({
  options,
  diagnostics: [],
  groups: [{ id: "ui", count: options.length, changed: 0 }],
  files: { user: "options.yml", repo: "metator.config.yml" },
});

describe("Settings' state", () => {
  test("a section chosen clears the search", () => {
    const s = createStore<SettingsState>()(Settings.create({ daemon: fakeDaemon().daemon }));
    s.getState().search("pane");
    s.getState().open("terminal");
    expect([s.getState().query, s.getState().section]).toEqual(["", "terminal"]);
  });

  test("a refused change says which option and counts for it alone; the options are read again", async () => {
    const reloadOptions = mock(async () => {});
    const { daemon, calls } = fakeDaemon(
      { setOption: { ok: false, error: { code: "INVALID", message: "not a number" } } },
      { reloadOptions },
    );
    const s = createStore<SettingsState>()(Settings.create({ daemon }));
    expect(await s.getState().change(option("ui.width", 3), 4)).toBe(false);
    expect(calls.setOption?.[0]).toEqual(["ui.width", { scope: "user", value: 4 }, "shop"]);
    expect([s.getState().notice?.text, s.getState().refusals, reloadOptions.mock.calls.length]).toEqual([
      "ui.width was not changed: not a number",
      { "ui.width": 1 },
      1,
    ]);
  });

  test("a reset sends the option's scope with reset; a repo option goes to the repository", async () => {
    const { daemon, calls } = fakeDaemon({}, { reloadOptions: async () => {} });
    const s = createStore<SettingsState>()(Settings.create({ daemon }));
    expect(await s.getState().change(option("git.base", "main", { scope: "repo" }), undefined, true)).toBe(
      true,
    );
    expect(calls.setOption?.[0]?.[1]).toEqual({ scope: "repo", reset: true });
    expect(s.getState().refusals).toEqual({});
  });

  test("the keys shown: the section's, or the search's matches; conflicts are worked out once per list", () => {
    const all = [option("ui.width", 1), option("ui.theme", "dark"), option("pane.prefix", "C-b")];
    expect(shownKeys(all, "ui", "")).toEqual(["ui.width", "ui.theme"]);
    expect(shownKeys(all, "ui", "prefix")).toEqual(["pane.prefix"]);
    expect(conflictsOf(all)).toBe(conflictsOf(all));
  });
});

describe("the app's own settings", () => {
  const commands = (over: Partial<Commands> = {}) =>
    ({
      cliInfo: async () => ({ source: "custom", path: "/src/metator", version: "1" }),
      setCliSource: async (source: string, path?: string) => ({
        source,
        path: path ?? "/bin/metator",
        version: "2",
      }),
      installCliCommand: async () => ({ path: "/home/ana/.local/bin/metator" }),
      uninstallCliCommand: async () => ({ path: undefined }),
      ...over,
    }) as unknown as Commands;

  test("a custom metator fills the path; a choice says what runs; a failure says why", async () => {
    const s = createStore<AppSettingsState>()(AppSettingsStore.create({ commands: commands() }));
    await s.getState().read();
    expect([s.getState().info?.path, s.getState().custom]).toEqual(["/src/metator", "/src/metator"]);
    await s.getState().choose("path");
    expect(s.getState().said).toEqual({ text: "The app now runs /bin/metator.", tone: "info" });
    await s.getState().uninstall();
    expect([s.getState().installed, s.getState().said?.text]).toEqual([
      undefined,
      "There was no metator command to remove.",
    ]);
    const failing = createStore<AppSettingsState>()(
      AppSettingsStore.create({
        commands: commands({
          setCliSource: async () => {
            throw new Error("no such file");
          },
        }),
      }),
    );
    await failing.getState().choose("custom", "/nope");
    expect(failing.getState().said?.tone).toBe("error");
    expect(failing.getState().said?.text).toStartWith("The source was not changed: ");
  });
});

let grabbedApp: StoreApi<AppSettingsState> | undefined;
function GrabApp() {
  grabbedApp = useScopedApi(AppSettingsStore);
  return null;
}
let grabbed: StoreApi<SettingsState> | undefined;
function Grab() {
  grabbed = useScopedApi(Settings);
  return null;
}

describe("parts of Settings", () => {
  beforeAll(() => {
    GlobalRegistrator.register();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  test("a changed option draws its own row again, not the others; a refusal draws only its row", async () => {
    const width = option("ui.width", 1);
    const theme = option("ui.theme", "dark");
    const { daemon } = fakeDaemon(
      { setOption: { ok: false, error: { message: "no" } } },
      { optionsView: view([width, theme]), reloadOptions: async () => {} },
    );
    const draws: Record<string, number> = {};
    const r = await drawRoot();
    r.draw(
      <ScopeProvider store={Settings} init={{ daemon }}>
        <Grab />
        {counted(draws, "width", <OptionRow optionKey="ui.width" />)}
        {counted(draws, "theme", <OptionRow optionKey="ui.theme" />)}
      </ScopeProvider>,
    );
    expect(draws).toEqual({ width: 1, theme: 1 });
    // The daemon's answer after a change: only ui.width is another value.
    r.act(() => publish(daemon, { ...daemon.getState(), optionsView: view([option("ui.width", 2), theme]) }));
    expect(draws).toEqual({ width: 2, theme: 1 });
    // The person wrote "light" and the daemon refused it: the field shows what holds again.
    const field = () => r.host.querySelector('[aria-label="ui.theme"]') as HTMLInputElement;
    field().value = "light";
    await r.act(async () => {
      await grabbed?.getState().change(theme, "light");
    });
    expect(draws).toEqual({ width: 2, theme: 2 });
    expect(field().value).toBe("dark");
    r.done();
  });

  test("writing a metator path draws the path field again, not what the app runs", async () => {
    const draws: Record<string, number> = {};
    const r = await drawRoot();
    r.draw(
      <ScopeProvider store={AppSettingsStore} init={{ commands: {} as Commands }}>
        <GrabApp />
        {counted(draws, "path", <CustomPath />)}
        {counted(draws, "info", <CliInfoLine />)}
      </ScopeProvider>,
    );
    r.act(() => grabbedApp?.getState().setCustom("/s"));
    r.act(() => grabbedApp?.getState().setCustom("/sr"));
    expect(draws).toEqual({ path: 3, info: 1 });
    r.done();
  });
});
