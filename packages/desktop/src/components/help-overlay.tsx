import { helpRows, type KeyMap, SHELL_KEYS } from "../model.ts";
import { Modal } from "./modal.tsx";

/** The keys of the app (`?`): the ones of every screen, and the workbench's from the `keys.*` options. */
export function HelpOverlay({ keymap, onClose }: { readonly keymap: KeyMap; onClose(): void }) {
  return (
    <Modal label="keyboard help" className="dialog help" closeOnBackdrop onClose={onClose}>
      <h2>Keys</h2>
      <h3>Everywhere, outside a field</h3>
      <dl className="keys">
        {SHELL_KEYS.map((k) => (
          <div key={k.keys}>
            <dt>
              <kbd>{k.keys}</kbd>
            </dt>
            <dd>{k.label}</dd>
          </div>
        ))}
      </dl>
      <h3>Work (the terminals)</h3>
      <dl className="keys" data-testid="help-workbench">
        {helpRows(keymap).map((k) => (
          <div key={k.id}>
            <dt>
              <kbd>{k.keys}</kbd>
            </dt>
            <dd>{k.label}</dd>
          </div>
        ))}
      </dl>
      <p className="dim">
        The keys of Work are options (<code>keys.*</code>): change them in Settings.
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
