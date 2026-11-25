/**
 * The first screen when the app knows no repository yet (round 20): one button, Add repository,
 * and what MetatorAI needs on this computer (git, and Claude Code or GitHub Copilot CLI). A
 * missing tool has its install link and Retry; the app installs none of them.
 */

import { useCallback, useEffect, useState } from "react";
import { errorText, type HostFix } from "../../shared/platform/tauri-commands.ts";
import { Button } from "../../ui/button.tsx";
import { type Requirement, ready, requirements } from "./repos.ts";
import { useRepos } from "./repos-context.tsx";

export function FirstRun() {
  const { commands } = useRepos();
  const [needs, setNeeds] = useState<readonly Requirement[]>();
  const [error, setError] = useState<string>();
  const check = useCallback(async () => {
    if (!commands) return;
    setError(undefined);
    try {
      // Any folder tells which tools this computer has: the one the app runs in.
      setNeeds(requirements(await commands.inspectFolder(".")));
    } catch (e) {
      setError(errorText(e));
    }
  }, [commands]);
  useEffect(() => {
    void check();
  }, [check]);
  return (
    <div className="setup-page" data-testid="first-run">
      <div className="panel">
        <h1>Welcome to MetatorAI</h1>
        <p className="muted">Add a repository to start. The app sets it up and opens it.</p>
        <a className="button-link primary big" href="#/add">
          Add repository
        </a>
        <h3>What MetatorAI needs</h3>
        <p className="dim">git, and Claude Code or GitHub Copilot CLI, installed and logged in.</p>
        {needs ? <RequirementList items={needs} onRetry={() => void check()} /> : null}
        {error ? <p className="dim">The app could not check: {error}</p> : null}
      </div>
    </div>
  );
}

/** Each tool with ✓ or what is missing; a missing one links to its install page. Retry checks again. */
export function RequirementList({
  items,
  onRetry,
}: {
  readonly items: readonly Requirement[];
  onRetry(): void;
}) {
  const allGood = ready(items);
  const missing = items.filter((r) => !r.ok);
  // With no host at all, each offered host is listed; one of them is enough.
  const noHost = items.filter((r) => r.id !== "git").every((r) => !r.ok);
  return (
    <div className="requirements" data-testid="requirements">
      <ul>
        {items.map((r) => (
          <li key={r.id} className={r.ok ? "ok" : "missing"}>
            <span className="mark" aria-hidden="true">
              {r.ok ? "✓" : "✕"}
            </span>
            <span className="name">{r.name}</span>
            {r.ok ? null : (
              <>
                <span className="dim">{r.problem}</span>
                {r.link ? (
                  <a href={r.link} target="_blank" rel="noreferrer">
                    How to install
                  </a>
                ) : null}
              </>
            )}
            {!r.ok && r.fix ? <FixHint fix={r.fix} /> : null}
          </li>
        ))}
      </ul>
      {noHost ? <p className="dim">One of the two is enough.</p> : null}
      {missing.length > 0 && !allGood ? <Button onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}

/**
 * How to add a missing tool to a dev container (round 21), in the engine's words: a feature line
 * for `devcontainer.json` (then Rebuild Container), or a command for the container's terminal.
 */
function FixHint({ fix }: { readonly fix: HostFix }) {
  return (
    <div className="fix" data-testid="fix">
      {fix.feature ? (
        <>
          <span className="dim">
            Add to the features of .devcontainer/devcontainer.json, then rebuild the container:
          </span>
          <Copyable text={fix.feature} />
        </>
      ) : null}
      {fix.command ? (
        <>
          <span className="dim">{fix.feature ? "Or run" : "Run"} in the container's terminal:</span>
          <Copyable text={fix.command} />
        </>
      ) : null}
    </div>
  );
}

function Copyable({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copyable">
      <code>{text}</code>
      <Button
        variant="ghost"
        onClick={() =>
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }
      >
        {copied ? "copied" : "copy"}
      </Button>
    </span>
  );
}
