/**
 * The main area when nothing answers at the daemon's address (D3).
 */

import { useDaemon, useDaemonStore } from "../shared/daemon/daemon.tsx";
import { ScopeProvider, scopedStore, useScoped, useScopedApi } from "../shared/state/scoped-store.ts";
import { Button } from "../ui/button.tsx";
import { CopyButton } from "../ui/copy-button.tsx";

interface AddressState {
  /** What the person typed, and the address it was typed for: another address starts from itself. */
  readonly typed: string;
  readonly forUrl: string;
  type(typed: string, forUrl: string): void;
}

/** The address field of the panel (ADR-0113): typing draws the field only. */
const Address = scopedStore<AddressState, string>("Address", (url) => (set) => ({
  typed: url,
  forUrl: url,
  type: (typed, forUrl) => set({ typed, forUrl }),
}));

/** The address shown: what was typed for this address, else the address itself. */
const shownAddress = (s: Pick<AddressState, "typed" | "forUrl">, url: string): string =>
  s.forUrl === url ? s.typed : url;

/**
 * The main area when nothing answers at the daemon's address (D3): what is wrong, the command
 * that starts the daemon, the address to try, and Retry. No screen draws over stale or empty data.
 */
export function NoDaemon() {
  const { url } = useDaemon("url");
  return (
    <ScopeProvider store={Address} init={url}>
      <div className="no-daemon" data-testid="no-daemon">
        <div className="panel">
          <h1>The daemon is not running</h1>
          <WhatIsWrong />
          <h3>Start it</h3>
          <StartIt />
          <h3>Or point the app at a daemon that runs elsewhere</h3>
          <AddressForm />
          <p className="dim">The app also tries again by itself every two seconds.</p>
        </div>
      </div>
    </ScopeProvider>
  );
}

function WhatIsWrong() {
  const { url, error } = useDaemon("url", "error");
  return (
    <p>
      This app shows what the MetatorAI daemon reports, and nothing answers at <code>{url}</code>
      {error ? <span className="dim"> ({error})</span> : null}. Sessions, questions and terminals appear here
      once it does.
    </p>
  );
}

function StartIt() {
  const { startable, folder, starting, startError, start } = useDaemon(
    "startable",
    "folder",
    "starting",
    "startError",
    "start",
  );
  return startable ? (
    <>
      <p className="muted">
        The app starts the daemon of {folder ? <code>{folder}</code> : "your repository"} itself, every time
        it opens.
      </p>
      {startError ? (
        <p className="dim" data-testid="start-error">
          The daemon did not start: {startError}
        </p>
      ) : null}
      <div className="addr">
        <Button variant="primary" disabled={starting || folder === ""} onClick={() => void start(folder)}>
          {starting ? "Starting…" : "Start it again"}
        </Button>
        <a className="button-link" href="#/add">
          Add repository…
        </a>
      </div>
    </>
  ) : (
    <>
      <p className="muted">
        In a terminal, in your repository or in a folder of repositories (new here?{" "}
        <a href="#/add">Add repository</a> lists every step):
      </p>
      <div className="cmd">
        <code>metator serve</code>
        <CopyButton text="metator serve" />
      </div>
    </>
  );
}

function AddressForm() {
  const daemon = useDaemonStore();
  const api = useScopedApi(Address);
  return (
    <form
      className="addr"
      onSubmit={(e) => {
        e.preventDefault();
        const { url, setUrl, retry } = daemon.getState();
        const address = shownAddress(api.getState(), url);
        if (address.trim() !== "" && address.trim() !== url) setUrl(address);
        else retry();
      }}
    >
      <AddressField />
      <Button type="submit" variant="primary">
        Retry
      </Button>
    </form>
  );
}

function AddressField() {
  const { url } = useDaemon("url");
  const address = useScoped(Address, (s) => shownAddress(s, url));
  const type = useScoped(Address, (s) => s.type);
  return (
    <input
      aria-label="daemon address"
      value={address}
      onChange={(e) => type(e.target.value, url)}
      placeholder="http://127.0.0.1:4310"
    />
  );
}
