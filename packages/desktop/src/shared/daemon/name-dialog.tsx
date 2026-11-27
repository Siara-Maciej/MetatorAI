/**
 * The one place the app asks who the person is: their name goes next to every answer they give.
 * The name being typed is the dialog's own store (ADR-0113): typing draws the field and Save.
 */

import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";
import { ScopeProvider, scopedStore, useScoped, useScopedApi } from "../state/scoped-store.ts";

interface NameState {
  readonly name: string;
  type(name: string): void;
}

const NameForm = scopedStore<NameState, string>("NameForm", (initial) => (set) => ({
  name: initial,
  type: (name) => set({ name }),
}));

export function NameDialog({ initial, onDone }: { readonly initial: string; onDone(name: string): void }) {
  return (
    <ScopeProvider store={NameForm} init={initial}>
      <NameFormBody onDone={onDone} />
    </ScopeProvider>
  );
}

function NameFormBody({ onDone }: { onDone(name: string): void }) {
  const api = useScopedApi(NameForm);
  return (
    <Modal label="your name" className="dialog name-dialog" onClose={() => onDone("")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const name = api.getState().name;
          if (name.trim()) onDone(name.trim());
        }}
      >
        <h2>Who are you?</h2>
        <p className="muted">
          Your name is written next to every answer, approval and note you give from this app. It is kept in
          this window; change it any time from the top bar.
        </p>
        <NameField />
        <div className="foot">
          <span className="spacer" />
          <Button onClick={() => onDone("")}>Cancel</Button>
          <SaveName />
        </div>
      </form>
    </Modal>
  );
}

function NameField() {
  const name = useScoped(NameForm, (s) => s.name);
  const type = useScoped(NameForm, (s) => s.type);
  return (
    <label className="field">
      <span>Your name</span>
      <input
        // biome-ignore lint/a11y/noAutofocus: the dialog opens because an action needs the name
        autoFocus
        value={name}
        onChange={(e) => type(e.target.value)}
        placeholder="for example: alice"
      />
    </label>
  );
}

function SaveName() {
  const blank = useScoped(NameForm, (s) => s.name.trim() === "");
  return (
    <Button type="submit" variant="primary" disabled={blank}>
      Save
    </Button>
  );
}
