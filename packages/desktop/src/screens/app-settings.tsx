/**
 * The app's own settings (round 20, ADR-0105): where the `metator` command comes from (the one
 * bundled with the app, the one on the PATH, or a path the person chose), "Install the metator
 * command" for a terminal and hooks outside the app (only on a click; it says where it wrote),
 * and the repositories the app knows, each with Open and Remove from the app. A dev container's
 * says so, with its container's state and where the repository is in it (round 21).
 */
import { useCallback, useEffect, useState } from "react";
import { cliSourceText, installedText, switcherRows } from "../repos.ts";
import { useRepos } from "../repos-context.tsx";
import { type CliInfo, type CliSource, errorText } from "../tauri-commands.ts";

const SOURCES: readonly CliSource[] = ["bundled", "path", "custom"];

export function AppSettings() {
  const repos = useRepos();
  const { commands } = repos;
  const [info, setInfo] = useState<CliInfo>();
  const [custom, setCustom] = useState("");
  const [installed, setInstalled] = useState<string>();
  const [said, setSaid] = useState<{ text: string; tone: "error" | "info" }>();
  const read = useCallback(async () => {
    if (!commands) return;
    try {
      const i = await commands.cliInfo();
      setInfo(i);
      if (i.source === "custom") setCustom(i.path);
    } catch (e) {
      setSaid({ text: `The app could not say which metator it uses: ${errorText(e)}`, tone: "error" });
    }
  }, [commands]);
  useEffect(() => {
    void read();
  }, [read]);
  // The dev containers' states, read again whenever Settings opens.
  const { refreshContainers } = repos;
  const anyContainer = repos.known?.some((k) => k.kind === "devcontainer") ?? false;
  useEffect(() => {
    if (anyContainer) void refreshContainers();
  }, [anyContainer, refreshContainers]);
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
  const act = async (what: () => Promise<string>, failed: string) => {
    setSaid(undefined);
    try {
      setSaid({ text: await what(), tone: "info" });
    } catch (e) {
      setSaid({ text: `${failed}: ${errorText(e)}`, tone: "error" });
    }
  };
  const choose = (source: CliSource, path?: string) =>
    act(async () => {
      const next = await commands.setCliSource(source, path);
      setInfo(next);
      return `The app now runs ${next.path}.`;
    }, "The source was not changed");
  const rows = switcherRows(repos.known ?? [], repos.current?.path, repos.states);
  return (
    <div className="app-settings" data-testid="app-settings">
      {said ? (
        <p
          className={said.tone === "error" ? "refusal" : "said"}
          role={said.tone === "error" ? "alert" : "status"}
        >
          {said.text}
        </p>
      ) : null}
      <section>
        <h2>The metator command</h2>
        <p className="muted">
          The app runs its own metator. Choose another only if you develop MetatorAI from a checkout.
        </p>
        <fieldset className="cli-source" data-testid="cli-source">
          <legend>Where it comes from</legend>
          {SOURCES.map((s) => (
            <label key={s}>
              <input
                type="radio"
                name="cli-source"
                checked={info?.source === s}
                disabled={s === "custom" && custom.trim() === ""}
                onChange={() => void choose(s, s === "custom" ? custom.trim() : undefined)}
              />
              {cliSourceText({ source: s })}
            </label>
          ))}
          <div className="addr">
            <input
              aria-label="custom metator path"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="/path/to/metator"
            />
            <button
              type="button"
              disabled={custom.trim() === ""}
              onClick={() => void choose("custom", custom.trim())}
            >
              Use this one
            </button>
          </div>
        </fieldset>
        {info ? (
          <p className="dim" data-testid="cli-info">
            {cliSourceText(info)}: <code>{info.path}</code> · version {info.version}
          </p>
        ) : null}
      </section>
      <section>
        <h2>Install the metator command</h2>
        <p className="muted">
          Everything the app starts finds metator by itself. To run it in your own terminal, or from a Claude
          Code you start by hand, put a small launcher in your user folder of programs.
        </p>
        <div className="actions">
          <button
            type="button"
            onClick={() =>
              void act(async () => {
                const r = await commands.installCliCommand();
                setInstalled(r.path);
                return installedText(r);
              }, "The command was not installed")
            }
          >
            Install the metator command
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              void act(async () => {
                const r = await commands.uninstallCliCommand();
                setInstalled(undefined);
                return r.path ? `Removed ${r.path}.` : "There was no metator command to remove.";
              }, "The command was not removed")
            }
          >
            Remove it
          </button>
        </div>
        {installed ? (
          <p className="dim" data-testid="installed-at">
            Installed at <code>{installed}</code>
          </p>
        ) : null}
      </section>
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
                {r.current ? null : (
                  <button type="button" onClick={() => void repos.open(r.path)}>
                    Open
                  </button>
                )}
                <button
                  type="button"
                  className="ghost"
                  title="The app forgets it; its files stay."
                  onClick={() =>
                    void repos.remove(r.path).then((why) => why && setSaid({ text: why, tone: "error" }))
                  }
                >
                  Remove from the app
                </button>
              </li>
            );
          })}
        </ul>
        <a className="button-link" href="#/add">
          Add repository…
        </a>
      </section>
    </div>
  );
}
