/**
 * Settings (S1, design/13 §1): every option of the registry in its group, with its effective
 * value, where it comes from (default, user, repo, run) and a way to change it or go back to the
 * default. The app draws; the daemon validates and writes the scope's file.
 *
 * The screen only lays its parts out (ADR-0113): what it keeps is the Settings store (`state.ts`);
 * a row reads only its own option, so a change draws that row again, not the list.
 */

import type { KeyboardEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import type { OptionDiagnostic, ResolvedOption } from "../../shared/api/api.ts";
import { RepoSelect } from "../../shared/components/repo-select.tsx";
import { useDaemon, useDaemonStore } from "../../shared/daemon/daemon.tsx";
import { ScopeProvider } from "../../shared/state/scoped-store.ts";
import { Button } from "../../ui/button.tsx";
import { moveInList } from "../../ui/list-keys.ts";
import { Notice } from "../../ui/notice.tsx";
import { fieldValue } from "./model.ts";
import { conflictsOf, shownKeys } from "./shown.ts";
import { Settings, useSettings, useSettingsApi, useSettingsDaemon } from "./state.ts";

export function SettingsScreen() {
  const daemon = useDaemonStore();
  return (
    <ScopeProvider store={Settings} init={{ daemon }}>
      <div className="settings-screen">
        <aside className="sections" onKeyDown={(e) => moveInList(e, "button.section", true)}>
          <div className="pick">
            <RepoSelect />
            <label htmlFor="settings-q" className="dim">
              search
            </label>
            <SearchField />
          </div>
          <SectionButtons />
          <SectionButton id="app" changed={0} count={2} />
          <div className="spacer" />
          <ScopeFiles />
        </aside>
        <section className="options-list">
          <SettingsNotice />
          <OptionsError />
          <SettingsBody />
        </section>
      </div>
    </ScopeProvider>
  );
}

function SearchField() {
  const query = useSettings((s) => s.query);
  const search = useSettings((s) => s.search);
  return (
    <input
      id="settings-q"
      placeholder="pane, prefix, notify…"
      value={query}
      onChange={(e) => search(e.target.value)}
    />
  );
}

const NO_GROUPS: readonly { readonly id: string; readonly count: number; readonly changed: number }[] = [];

/** The sections are the daemon's groups: one per option group, in the registry's order. */
function SectionButtons() {
  const groups = useSettingsDaemon((d) => d.optionsView?.groups ?? NO_GROUPS);
  return groups.map((g) => <SectionButton key={g.id} id={g.id} changed={g.changed} count={g.count} />);
}

/** One section: it hears only whether it is the one shown. */
function SectionButton({
  id,
  changed,
  count,
}: {
  readonly id: string;
  readonly changed: number;
  readonly count: number;
}) {
  const current = useSettings((s) => s.query === "" && s.section === id);
  const open = useSettings((s) => s.open);
  return (
    <Button className="section" aria-current={current ? "true" : undefined} onClick={() => open(id)}>
      <span>{id}</span>
      <span className="dim">
        {changed > 0 ? <span className="amber">{changed} · </span> : null}
        {count}
      </span>
    </Button>
  );
}

function ScopeFiles() {
  const user = useSettingsDaemon((d) => d.optionsView?.files.user);
  const repo = useSettingsDaemon((d) => d.optionsView?.files.repo);
  return (
    <div className="dim files">
      user: {user ?? "options.yml"} · repo: {repo ?? "metator.config.yml"}
    </div>
  );
}

/** What a change answered stays until closed: the refresh never clears a refusal (D5). */
function SettingsNotice() {
  const notice = useSettings((s) => s.notice);
  const closeNotice = useSettings((s) => s.closeNotice);
  return <Notice text={notice?.text} tone={notice?.tone ?? "error"} onClose={closeNotice} />;
}

function OptionsError() {
  const error = useSettingsDaemon((d) => (d.optionsView ? undefined : d.optionsError));
  return error ? <div className="banner">{error}</div> : null;
}

function SettingsBody() {
  const app = useSettings((s) => s.section === "app" && s.query === "");
  return app ? <AppSection /> : <OptionList />;
}

/** The app section: this window's own fields. */
function AppSection() {
  return (
    <>
      <div className="dim lead">app · this window only: where the daemon is and who you are</div>
      <UrlField />
      <NameField />
    </>
  );
}

function UrlField() {
  const { url, setUrl } = useDaemon("url", "setUrl");
  return (
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
  );
}

function NameField() {
  const { me, setMe } = useDaemon("me", "setMe");
  return (
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
  );
}

const NO_OPTIONS: readonly ResolvedOption[] = [];

/** The keys of the options shown: the section's, or the search's matches. */
function useShownKeys(): readonly string[] {
  const section = useSettings((s) => s.section);
  const query = useSettings((s) => s.query);
  return useSettingsDaemon(
    useShallow((d) => shownKeys(d.optionsView?.options ?? NO_OPTIONS, section, query)),
  );
}

function OptionList() {
  const keys = useShownKeys();
  return (
    <>
      <OptionsLead count={keys.length} />
      {keys.map((key) => (
        <OptionRow key={key} optionKey={key} />
      ))}
      {keys.length === 0 ? <div className="empty">No option matches.</div> : null}
    </>
  );
}

function OptionsLead({ count }: { readonly count: number }) {
  const section = useSettings((s) => s.section);
  const query = useSettings((s) => s.query);
  return (
    <div className="dim lead">
      {query
        ? `${count} matching options`
        : `${section} · a change applies at once; "restart" marks the ones the daemon reads at start`}
    </div>
  );
}

const NO_DIAGNOSTICS: readonly OptionDiagnostic[] = [];
const NO_CONFLICTS: readonly string[] = [];

/** One option: it reads only its own option, its diagnostics, its key conflicts and its refusals. */
export function OptionRow({ optionKey }: { readonly optionKey: string }) {
  const o = useSettingsDaemon((d) => d.optionsView?.options.find((x) => x.key === optionKey));
  const diagnostics = useSettingsDaemon(
    useShallow((d) => (d.optionsView?.diagnostics ?? NO_DIAGNOSTICS).filter((x) => x.key === optionKey)),
  );
  // A key bound to two actions is said on both rows; the daemon accepts each on its own.
  const conflicts = useSettingsDaemon(
    (d) => conflictsOf(d.optionsView?.options ?? NO_OPTIONS)[optionKey] ?? NO_CONFLICTS,
  );
  const refused = useSettings((s) => s.refusals[optionKey] ?? 0);
  const api = useSettingsApi();
  if (!o) return null;
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
      <OptionInput
        // The field is the option at its value: a reset or a refused change draws it again with
        // what holds, instead of leaving what was typed (D6).
        key={`${JSON.stringify(o.value)}:${String(refused)}`}
        option={o}
        onChange={(v) => void api.getState().change(o, v)}
      />
      <span className={`src ${o.source}`}>{o.source}</span>
      {o.source !== "default" && !d.fixed ? (
        <Button variant="ghost" onClick={() => void api.getState().change(o, undefined, true)}>
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
