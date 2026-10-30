import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { MetatorContainer } from "@metator/runtime";
import type { Folder } from "./context.ts";

export interface AskPlace {
  readonly container: MetatorContainer;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly where: string;
  /** Where the folder's repositories really are, when they are links to elsewhere. */
  readonly dirs?: readonly string[];
}

/**
 * Where a question is asked (G3): in a repository, the repository; in a folder of repositories,
 * the folder (its conversations live there), with the host files of its first repository that
 * has mt-guide installed.
 */
export function askPlace(ctx: {
  readonly container: () => MetatorContainer;
  readonly containerAt: (root: string) => MetatorContainer;
  readonly folder: () => Folder | null;
}): AskPlace {
  const f = ctx.folder();
  if (!f) {
    const container = ctx.container();
    const root = container.resolve("root");
    return { container, cwd: root, projectRoot: root, where: "this repository" };
  }
  return folderPlace(f, ctx.containerAt(f.root));
}

export function folderPlace(f: Folder, container: MetatorContainer): AskPlace {
  const withAgents = f.repos.find(
    (r) =>
      existsSync(join(r.root, ".claude/agents/mt-guide.md")) ||
      existsSync(join(r.root, ".github/agents/mt-guide.agent.md")),
  );
  // A repository linked into the folder lives elsewhere: the guide is told where, and may read there.
  const realOf = (dir: string) => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  };
  const repos = f.repos.map((r) => ({ ...r, real: realOf(r.root) }));
  const dirs = repos.filter((r) => r.real !== r.root).map((r) => r.real);
  const named = repos.map((r) =>
    r.real === r.root ? `${r.name} (${r.path})` : `${r.name} (${r.path}, a link to ${r.real})`,
  );
  return {
    container,
    cwd: f.root,
    projectRoot: withAgents?.root ?? f.root,
    where: `the folder ${f.root}, which holds the repositories ${named.join(", ")}`,
    ...(dirs.length > 0 ? { dirs } : {}),
  };
}
