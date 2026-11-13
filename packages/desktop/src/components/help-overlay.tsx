import { useState } from "react";
import { filterKeys, helpRows, type KeyMap, SHELL_KEYS } from "../model.ts";
import { Modal } from "./modal.tsx";

/**
 * The keys of the app (`?`): the ones of every screen, and the Terminals' from the `keys.*`
 * options. The field on top filters both lists as you type (`/` goes to it).
 */
export function HelpOverlay({ keymap, onClose }: { readonly keymap: KeyMap; onClose(): void }) {
  const [query, setQuery] = useState("");
  const shell = filterKeys(SHELL_KEYS, query);
  const terminals = filterKeys(helpRows(keymap), query);
  return (
    <Modal label="keyboard help" className="dialog help" closeOnBackdrop onClose={onClose}>
      <div className="help-head">
        <h2>Keys</h2>
        <input
          // biome-ignore lint/a11y/noAutofocus: the overlay is a keyboard tool; typing filters it
          autoFocus
          aria-label="filter the keys"
          placeholder="/ filter: a key or what it does"
          value={query}
          onChange={(e) => setQuery(e.target.value.replace(/^\//, ""))}
        />
      </div>
      {shell.length > 0 ? (
        <>
          <h3>Everywhere, outside a field</h3>
          <dl className="keys" data-testid="help-shell">
            {shell.map((k) => (
              <div key={k.keys}>
                <dt>
                  <kbd>{k.keys}</kbd>
                </dt>
                <dd>{k.label}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
      {terminals.length > 0 ? (
        <>
          <h3>Terminals</h3>
          <dl className="keys" data-testid="help-workbench">
            {terminals.map((k) => (
              <div key={k.id}>
                <dt>
                  <kbd>{k.keys}</kbd>
                </dt>
                <dd>{k.label}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
      {shell.length + terminals.length === 0 ? <p className="muted">No key matches.</p> : null}
      <p className="dim">
        The keys of Terminals are options (<code>keys.*</code>): change them in Settings.
      </p>
      <div className="foot">
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
