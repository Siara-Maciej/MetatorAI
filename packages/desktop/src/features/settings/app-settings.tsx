/**
 * The app's own settings (round 20, ADR-0105): where the `metator` command comes from (the one
 * bundled with the app, the one on the PATH, or a path the person chose), "Install the metator
 * command" for a terminal and hooks outside the app (only on a click; it says where it wrote),
 * and the repositories the app knows, each with Open and Remove from the app. A dev container's
 * says so, with its container's state and where the repository is in it (round 21).
 *
 * What it keeps is the AppSettings store (`state.ts`); each part reads only the value it draws,
 * so writing a path draws the path field again, not the page.
 */

import { useEffect } from "react";
import type { CliSource } from "../../shared/platform/tauri-commands.ts";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { cliSourceText, switcherRows } from "../repos/repos.ts";
import { useRepos } from "../repos/repos-context.tsx";
import { AppSettingsStore, useAppSettings, useAppSettingsApi } from "./state.ts";

const SOURCES: readonly CliSource[] = ["bundled", "path", "custom"];

export function AppSettings() {
  const { commands } = useRepos();
  if (!commands)
    return (
      <div className="app-settings" data-testid="app-settings">
        <h2>The desktop app</h2>
        <p className="muted">
          These settings are the desktop app's: which metator it runs, and the repositories it knows. In a
          browser the app shows the daemon you started.
        </p>
      </div>
    );
  return (
    <ScopeProvider store={AppSettingsStore} init={{ commands }}>
      <AppSettingsPage />
    </ScopeProvider>
  );
}

function AppSettingsPage() {
  // Which metator the app runs, read when the page opens.
  const read = useAppSettings((s) => s.read);
  useEffect(() => {
    void read();
  }, [read]);
  return (
    <div className="app-settings" data-testid="app-settings">
      <Said />
      <section>
        <h2>The metator command</h2>
        <p className="muted">
          The app runs its own metator. Choose another only if you develop MetatorAI from a checkout.
        </p>
        <fieldset className="cli-source" data-testid="cli-source">
          <legend>Where it comes from</legend>
          {SOURCES.map((s) => (
            <SourceChoice key={s} source={s} />
          ))}
          <div className="addr">
            <CustomPath />
            <UseCustom />
          </div>
        </fieldset>
        <CliInfoLine />
      </section>
      <section>
        <h2>Install the metator command</h2>
        <p className="muted">
          Everything the app starts finds metator by itself. To run it in your own terminal, or from a Claude
          Code you start by hand, put a small launcher in your user folder of programs.
        </p>
        <InstallButtons />
        <InstalledAt />
      </section>
      <Repositories />
    </div>
  );
}

/** What the last command said. */
function Said() {
  const said = useAppSettings((s) => s.said);
  return said ? (
    <p
      className={said.tone === "error" ? "refusal" : "said"}
      role={said.tone === "error" ? "alert" : "status"}
    >
      {said.text}
    </p>
  ) : null;
}

function SourceChoice({ source }: { readonly source: CliSource }) {
  const checked = useAppSettings((s) => s.info?.source === source);
  // Only the custom choice hears of the path: whether there is one to choose.
  const blank = useAppSettings((s) => source === "custom" && s.custom.trim() === "");
  const api = useAppSettingsApi();
  return (
    <label>
      <input
        type="radio"
        name="cli-source"
        checked={checked}
        disabled={blank}
        onChange={() => {
          const s = api.getState();
          void s.choose(source, source === "custom" ? s.custom.trim() : undefined);
        }}
      />
      {cliSourceText({ source })}
    </label>
  );
}

export function CustomPath() {
  const custom = useAppSettings((s) => s.custom);
  const setCustom = useAppSettings((s) => s.setCustom);
  return (
    <input
      aria-label="custom metator path"
      value={custom}
      onChange={(e) => setCustom(e.target.value)}
      placeholder="/path/to/metator"
    />
  );
}

function UseCustom() {
  const blank = useAppSettings((s) => s.custom.trim() === "");
  const api = useAppSettingsApi();
  return (
    <Button
      disabled={blank}
      onClick={() => {
        const s = api.getState();
        void s.choose("custom", s.custom.trim());
      }}
    >
      Use this one
    </Button>
  );
}

export function CliInfoLine() {
  const info = useAppSettings((s) => s.info);
  return info ? (
    <p className="dim" data-testid="cli-info">
      {cliSourceText(info)}: <code>{info.path}</code> · version {info.version}
    </p>
  ) : null;
}

function InstallButtons() {
  const api = useAppSettingsApi();
  return (
    <div className="actions">
      <Button onClick={() => void api.getState().install()}>Install the metator command</Button>
      <Button variant="ghost" onClick={() => void api.getState().uninstall()}>
        Remove it
      </Button>
    </div>
  );
}

function InstalledAt() {
  const installed = useAppSettings((s) => s.installed);
  return installed ? (
    <p className="dim" data-testid="installed-at">
      Installed at <code>{installed}</code>
    </p>
  ) : null;
}

/** The repositories the app knows; the dev containers' states are read again whenever Settings opens. */
function Repositories() {
  const repos = useRepos();
  const say = useAppSettings((s) => s.say);
  const { refreshContainers } = repos;
  const anyContainer = repos.known?.some((k) => k.kind === "devcontainer") ?? false;
  useEffect(() => {
    if (anyContainer) void refreshContainers();
  }, [anyContainer, refreshContainers]);
  const rows = switcherRows(repos.known ?? [], repos.current?.path, repos.states);
  return (
    <section>
      <h2>Repositories</h2>
      <ul className="known-repos" data-testid="known-repos">
        {rows.map((r) => {
          const k = repos.known?.find((x) => x.path === r.path);
          const where = k?.devcontainer
            ? `${k.devcontainer.workspaceFolder} in the container of ${k.devcontainer.localFolder}`
            : r.path;
          return (
            <li key={r.path} data-kind={r.kind}>
              <span className="name">
                {r.name}
                {r.note ? <span className={`dim state ${r.state ?? ""}`}> · {r.note}</span> : null}
                {r.current ? <span className="dim"> · open</span> : null}
              </span>
              <code className="dim path">{where}</code>
              {r.current ? null : <Button onClick={() => void repos.open(r.path)}>Open</Button>}
              <Button
                variant="ghost"
                title="The app forgets it; its files stay."
                onClick={() =>
                  void repos.remove(r.path).then((why) => why && say({ text: why, tone: "error" }))
                }
              >
                Remove from the app
              </Button>
            </li>
          );
        })}
      </ul>
      <a className="button-link" href="#/add">
        Add repository…
      </a>
    </section>
  );
}
