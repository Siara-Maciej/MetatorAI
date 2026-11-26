/**
 * Settings (S1, design/13 §1): every option of the registry in its group, with its effective
 * value, where it comes from (default, user, repo, run) and a way to change it or go back to the
 * default. The app draws; the daemon validates and writes the scope's file.
 */

import { type KeyboardEvent, useMemo, useState } from "react";
import type { OptionDiagnostic, OptionScope, ResolvedOption } from "../../shared/api/api.ts";
import { RepoSelect } from "../../shared/components/repo-select.tsx";
import { useDaemon } from "../../shared/daemon/daemon.tsx";
import { useAction } from "../../shared/hooks.ts";
import { refusalText } from "../../shared/model/format.ts";
import { Button } from "../../ui/button.tsx";
import { moveInList } from "../../ui/list-keys.ts";
import { Notice } from "../../ui/notice.tsx";
import { fieldValue, keyConflicts, optionMatches } from "./model.ts";

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
  } = useDaemon(
    "client",
    "repo",
    "url",
    "me",
    "setMe",
    "setUrl",
    "optionsView",
    "optionsError",
    "reloadOptions",
  );
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
  // A key bound to two actions is said on both rows; the daemon accepts each on its own.
  const conflicts = useMemo(() => keyConflicts(view?.options ?? []), [view]);
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
      <aside className="sections" onKeyDown={(e) => moveInList(e, "button.section", true)}>
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
          <Button
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
          </Button>
        ))}
        <Button
          className="section"
          aria-current={query === "" && section === "app" ? "true" : undefined}
          onClick={() => {
            setQuery("");
            setSection("app");
          }}
        >
          <span>app</span>
          <span className="dim">2</span>
        </Button>
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
                onKeyDown={commitOnEnter}
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
                onKeyDown={commitOnEnter}
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
                conflicts={conflicts[o.key] ?? []}
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
  conflicts,
  onChange,
}: {
  readonly option: ResolvedOption;
  readonly diagnostics: readonly OptionDiagnostic[];
  /** The other actions bound to one of its keys. */
  readonly conflicts: readonly string[];
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
        {conflicts.map((c) => (
          <div key={c} className="d amber" data-testid="key-conflict">
            {c}: one key, two actions
          </div>
        ))}
      </div>
      <OptionInput option={o} onChange={(v) => onChange(o, v)} />
      <span className={`src ${o.source}`}>{o.source}</span>
      {o.source !== "default" && !d.fixed ? (
        <Button variant="ghost" onClick={() => onChange(o, undefined, true)}>
          default
        </Button>
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
  // number, list, keybinding, string, command: one field committed on Enter or when left; lists
  // and keys as `a, b`. What changes nothing (an emptied number) puts back the value that holds.
  const text = Array.isArray(o.value) ? (o.value as string[]).join(", ") : String(o.value ?? "");
  return (
    <input
      type={d.kind === "number" ? "number" : undefined}
      aria-label={o.key}
      className={d.kind === "keybinding" || d.kind === "command" ? "mono" : undefined}
      defaultValue={text}
      min={d.min}
      max={d.max}
      disabled={disabled}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.value = text;
        commitOnEnter(e);
      }}
      onBlur={(e) => {
        const next = fieldValue(d, e.target.value, o.value);
        if (next) onChange(next.value);
        else e.target.value = text;
      }}
    />
  );
}

/** Enter commits a field as leaving it does. */
function commitOnEnter(e: KeyboardEvent<HTMLInputElement>) {
  if (e.key === "Enter") e.currentTarget.blur();
}
