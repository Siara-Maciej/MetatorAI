/** Small pieces several screens share: the repository select, a notice that stays, the no-daemon panel. */
import { useEffect, useState } from "react";
import { useDaemon } from "../daemon.tsx";

/**
 * The repository a list screen shows (D10): only when the daemon serves a folder of repositories.
 * The choice is the app's, remembered, and the same on every list screen.
 */
export function RepoSelect() {
  const { repos, repo, setRepo } = useDaemon();
  if (repos.length === 0) return null;
  return (
    <label className="repo-select">
      <span className="dim">repository</span>
      <select aria-label="repository" value={repo ?? ""} onChange={(e) => setRepo(e.target.value)}>
        {repos.map((r) => (
          <option key={r.name} value={r.name}>
            {r.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * What an action answered (D5): it stays until the person closes it or the next action replaces
 * it; a refresh of the screen's data never clears it.
 */
export function Notice({
  text,
  tone = "error",
  onClose,
}: {
  readonly text: string | undefined;
  readonly tone?: "error" | "info";
  onClose(): void;
}) {
  if (!text) return null;
  return (
    <div className={`banner notice ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="msg">{text}</span>
      <button type="button" className="ghost" aria-label="dismiss" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

/**
 * The main area when nothing answers at the daemon's address (D3): what is wrong, the command
 * that starts the daemon, the address to try, and Retry. No screen draws over stale or empty data.
 */
export function NoDaemon() {
  const { url, error, setUrl, retry } = useDaemon();
  const [address, setAddress] = useState(url);
  useEffect(() => setAddress(url), [url]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText("metator serve")
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <div className="no-daemon" data-testid="no-daemon">
      <div className="panel">
        <h1>The daemon is not running</h1>
        <p>
          This app shows what the MetatorAI daemon reports, and nothing answers at <code>{url}</code>
          {error ? <span className="dim"> ({error})</span> : null}. Sessions, questions and terminals appear
          here once it does.
        </p>
        <h3>Start it</h3>
        <p className="muted">In a terminal, in your repository or in a folder of repositories:</p>
        <div className="cmd">
          <code>metator serve</code>
          <button type="button" className="ghost" onClick={copy}>
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <h3>Or point the app at a daemon that runs elsewhere</h3>
        <form
          className="addr"
          onSubmit={(e) => {
            e.preventDefault();
            if (address.trim() !== "" && address.trim() !== url) setUrl(address);
            else retry();
          }}
        >
          <input
            aria-label="daemon address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="http://127.0.0.1:4310"
          />
          <button type="submit" className="primary">
            Retry
          </button>
        </form>
        <p className="dim">The app also tries again by itself every two seconds.</p>
      </div>
    </div>
  );
}
