/**
 * The repository a list screen shows (D10), the same choice on every list screen.
 */
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useDaemonStore } from "../daemon/daemon.tsx";
import { plural } from "../model/format.ts";
import { placeLabel, worktreeCount } from "../model/places.ts";

/**
 * The repository a list screen shows (D10): only when the daemon serves a folder of repositories.
 * The choice is the app's, remembered, and the same on every list screen. It reads only what it
 * draws (ADR-0113): the places' names and labels, the one chosen and its count of worktrees.
 */
export function RepoSelect() {
  const store = useDaemonStore();
  const names = useStore(
    store,
    useShallow((d) => d.repos.map((r) => r.name)),
  );
  const labels = useStore(
    store,
    useShallow((d) => d.repos.map((r) => placeLabel(r))),
  );
  const repo = useStore(store, (d) => d.repo);
  // A worktree is a place of its own (`shop (fix-tax)`); its repository's count of them stays dim.
  const worktrees = useStore(store, (d) => worktreeCount(d.repos, d.repo));
  if (names.length === 0) return null;
  return (
    <label className="repo-select">
      <span className="dim">repository</span>
      <select
        aria-label="repository"
        value={repo ?? ""}
        onChange={(e) => store.getState().setRepo(e.target.value)}
      >
        {names.map((name, i) => (
          <option key={name} value={name}>
            {labels[i]}
          </option>
        ))}
      </select>
      {worktrees > 0 ? <span className="dim">· {plural(worktrees, "worktree")}</span> : null}
    </label>
  );
}
