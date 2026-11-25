/**
 * The repository a list screen shows (D10), the same choice on every list screen.
 */
import { useDaemon } from "../daemon/daemon.tsx";
import { plural } from "../model/format.ts";
import { placeLabel, worktreeCount } from "../model/places.ts";

/**
 * The repository a list screen shows (D10): only when the daemon serves a folder of repositories.
 * The choice is the app's, remembered, and the same on every list screen.
 */
export function RepoSelect() {
  const { repos, repo, setRepo } = useDaemon("repos", "repo", "setRepo");
  if (repos.length === 0) return null;
  // A worktree is a place of its own (`shop (fix-tax)`); its repository's count of them stays dim.
  const worktrees = worktreeCount(repos, repo);
  return (
    <label className="repo-select">
      <span className="dim">repository</span>
      <select aria-label="repository" value={repo ?? ""} onChange={(e) => setRepo(e.target.value)}>
        {repos.map((r) => (
          <option key={r.name} value={r.name}>
            {placeLabel(r)}
          </option>
        ))}
      </select>
      {worktrees > 0 ? <span className="dim">· {plural(worktrees, "worktree")}</span> : null}
    </label>
  );
}
