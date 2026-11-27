import { filterKeys, helpRows, type KeyMap, SHELL_KEYS } from "../shared/model/keys.ts";
import { ScopeProvider, scopedStore, useScoped } from "../shared/state/scoped-store.ts";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/modal.tsx";

interface HelpFilterState {
  readonly query: string;
  filter(query: string): void;
}

/** What the overlay's filter holds while it is open (ADR-0113): typing draws the field and the lists. */
const HelpFilter = scopedStore<HelpFilterState, undefined>("HelpFilter", () => (set) => ({
  query: "",
  filter: (query) => set({ query }),
}));

/**
 * The keys of the app (`?`): the ones of every screen, and the Terminals' from the `keys.*`
 * options. The field on top filters both lists as you type (`/` goes to it).
 */
export function HelpOverlay({ keymap, onClose }: { readonly keymap: KeyMap; onClose(): void }) {
  return (
    <Modal label="keyboard help" className="dialog help" closeOnBackdrop onClose={onClose}>
      <ScopeProvider store={HelpFilter} init={undefined}>
        <div className="help-head">
          <h2>Keys</h2>
          <FilterField />
        </div>
        <KeyLists keymap={keymap} />
      </ScopeProvider>
      <p className="dim">
        The keys of Terminals are options (<code>keys.*</code>): change them in Settings.
      </p>
      <div className="foot">
        <span className="spacer" />
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

function FilterField() {
  const query = useScoped(HelpFilter, (s) => s.query);
  const filter = useScoped(HelpFilter, (s) => s.filter);
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the overlay is a keyboard tool; typing filters it
      autoFocus
      aria-label="filter the keys"
      placeholder="/ filter: a key or what it does"
      value={query}
      onChange={(e) => filter(e.target.value.replace(/^\//, ""))}
    />
  );
}

function KeyLists({ keymap }: { readonly keymap: KeyMap }) {
  const query = useScoped(HelpFilter, (s) => s.query);
  const shell = filterKeys(SHELL_KEYS, query);
  const terminals = filterKeys(helpRows(keymap), query);
  return (
    <>
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
    </>
  );
}
