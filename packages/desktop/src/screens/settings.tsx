/**
 * Settings (S1, design/13 §1): every option of the registry in its group, with its effective
 * value, where it comes from (default, user, repo, run) and a way to change it or go back to the
 * default. The app draws; the daemon validates and writes the scope's file.
 */
import { useMemo, useState } from "react";
import type { OptionDiagnostic, OptionScope, ResolvedOption } from "../api.ts";
import { Notice, RepoSelect } from "../components/common.tsx";
import { useDaemon } from "../daemon.tsx";
import { useAction } from "../hooks.ts";
import { optionMatches, refusalText } from "../model.ts";

export function SettingsScreen() {
  const {
    client,
    repo,
    url,
    me,
    setMe,
    setUrl,
    optionsView: view,
    optionsError,
    reloadOptions,
  } = useDaemon();
  // What a change answered stays until closed: the refresh never clears a refusal (D5).
  const action = useAction(reloadOptions);
  const [section, setSection] = useState<string>("ui");
  const [query, setQuery] = useState("");
  // Counts refusals: a field whose value was refused is drawn again with the value that holds.
  const [refused, setRefused] = useState(0);
  // The sections are the daemon's groups: one per option group, in the registry's order.
  const sections = view?.groups ?? [];
  const shown = useMemo(() => {
    const all = view?.options ?? [];
    return query.trim() !== ""
      ? all.filter((o) => optionMatches(o, query))
      : all.filter((o) => o.key.startsWith(`${section}.`));
  }, [view, section, query]);
  const diagnosticsOf = (key: string): OptionDiagnostic[] =>
    (view?.diagnostics ?? []).filter((d) => d.key === key);
  const change = async (o: ResolvedOption, value: unknown, reset = false) => {
    const scope: OptionScope = o.definition.scope === "user" ? "user" : "repo";
    // The options are read again either way: a refused value must not stay in the field (D6).
    const ok = await action.run(async () => {
      const r = await client.setOption(o.key, reset ? { scope, reset: true } : { scope, value }, repo);
      return r.ok
        ? r
        : {
            ok: false,
            error: {
              code: r.error?.code ?? "REFUSED",
              message: `${o.key} was not changed: ${refusalText(r.error)}`,
            },
          };
    });
    if (!ok) setRefused((n) => n + 1);
  };
  return (
    <div className="settings-screen">
      <aside className="sections">
        <div className="pick">
          <RepoSelect />
          <label htmlFor="settings-q" className="dim">
            search
          </label>
          <input
            id="settings-q"
            placeholder="pane, prefix, notify…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {sections.map((s) => (
          <button
            type="button"
            key={s.id}
            className="section"
            aria-current={query === "" && s.id === section ? "true" : undefined}
            onClick={() => {
              setQuery("");
              setSection(s.id);
            }}
          >
            <span>{s.id}</span>
            <span className="dim">
              {s.changed > 0 ? <span className="amber">{s.changed} · </span> : null}
              {s.count}
            </span>
          </button>
        ))}
        <button
          type="button"
          className="section"
          aria-current={query === "" && section === "app" ? "true" : undefined}
          onClick={() => {
            setQuery("");
            setSection("app");
          }}
        >
          <span>app</span>
          <span className="dim">2</span>
        </button>
        <div className="spacer" />
        <div className="dim files">
          user: {view?.files.user ?? "options.yml"} · repo: {view?.files.repo ?? "metator.config.yml"}
        </div>
      </aside>
      <section className="options-list">
        <Notice {...action.notice} />
        {optionsError && !view ? <div className="banner">{optionsError}</div> : null}
        {section === "app" && query === "" ? (
          <>
            <div className="dim lead">app · this window only: where the daemon is and who you are</div>
            <div className="opt">
              <div className="k">
                daemon url<div className="d dim">The address of `metator serve` this app talks to.</div>
              </div>
              <input
                key={url}
                aria-label="daemon url"
                defaultValue={url}
                onBlur={(e) => {
                  if (e.target.value.trim() !== "" && e.target.value !== url) setUrl(e.target.value);
                }}
              />
              <span className="src dim">this window</span>
              <span />
            </div>
            <div className="opt">
              <div className="k">
                your name<div className="d dim">Who attaches, answers and approves from this app.</div>
              </div>
              <input
                key={me}
                aria-label="your name"
                defaultValue={me}
                onBlur={(e) => setMe(e.target.value.trim())}
              />
              <span className="src dim">this window</span>
              <span />
            </div>
          </>
        ) : (
          <>
            <div className="dim lead">
              {query
                ? `${shown.length} matching options`
                : `${section} · a change applies at once; "restart" marks the ones the daemon reads at start`}
            </div>
            {shown.map((o) => (
              <OptionRow
                // The row is the option at its value: a reset or a refused change draws the field
                // again with what holds, instead of leaving what was typed (D6).
                key={`${o.key}:${JSON.stringify(o.value)}:${String(refused)}`}
                option={o}
                diagnostics={diagnosticsOf(o.key)}
                onChange={change}
              />
            ))}
            {shown.length === 0 ? <div className="empty">No option matches.</div> : null}
          </>
        )}
      </section>
    </div>
  );
}

function OptionRow({
  option: o,
  diagnostics,
  onChange,
}: {
  readonly option: ResolvedOption;
  readonly diagnostics: readonly OptionDiagnostic[];
  onChange(option: ResolvedOption, value: unknown, reset?: boolean): Promise<void>;
}) {
  const d = o.definition;
  const name = o.key.slice(o.key.indexOf(".") + 1);
  return (
    <div className="opt" data-testid={`option-${o.key}`} data-source={o.source}>
      <div className="k">
        {name}
        {d.restart !== "none" ? <span className="chip">{`restart ${d.restart}`}</span> : null}
        {d.runsLocally ? <span className="chip">runs locally</span> : null}
        <div className="d dim">{d.description}</div>
        {diagnostics.map((x) => (
          <div key={x.message} className="d amber">
            {x.source}: {x.message}
          </div>
        ))}
      </div>
      <OptionInput option={o} onChange={(v) => onChange(o, v)} />
      <span className={`src ${o.source}`}>{o.source}</span>
      {o.source !== "default" && !d.fixed ? (
        <button type="button" className="ghost" onClick={() => onChange(o, undefined, true)}>
          default
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

function OptionInput({
  option: o,
  onChange,
}: {
  readonly option: ResolvedOption;
  onChange(value: unknown): void;
}) {
  const d = o.definition;
  const disabled = d.fixed;
  if (d.kind === "boolean")
    return (
      <label className="toggle">
        <input
          type="checkbox"
          aria-label={o.key}
          checked={o.value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{o.value === true ? "on" : "off"}</span>
      </label>
    );
  if (d.kind === "enum")
    return (
      <select
        aria-label={o.key}
        value={String(o.value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {(d.choices ?? []).map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  if (d.kind === "number")
    return (
      <input
        type="number"
        aria-label={o.key}
        defaultValue={Number(o.value)}
        min={d.min}
        max={d.max}
        disabled={disabled}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (n !== o.value) onChange(n);
        }}
      />
    );
  // list, keybinding, string, command: one text field; lists and keys as `a, b`.
  const text = Array.isArray(o.value) ? (o.value as string[]).join(", ") : String(o.value ?? "");
  return (
    <input
      aria-label={o.key}
      className={d.kind === "keybinding" || d.kind === "command" ? "mono" : undefined}
      defaultValue={text}
      disabled={disabled}
      onBlur={(e) => {
        const v = e.target.value;
        if (v === text) return;
        onChange(
          d.kind === "list" || d.kind === "keybinding"
            ? v
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s !== "")
            : v,
        );
      }}
    />
  );
}
