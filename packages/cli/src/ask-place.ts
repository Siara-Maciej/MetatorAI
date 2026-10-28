import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MetatorContainer } from "@metator/runtime";
import type { Folder } from "./context.ts";

export interface AskPlace {
  readonly container: MetatorContainer;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly where: string;
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
  return {
    container,
    cwd: f.root,
    projectRoot: withAgents?.root ?? f.root,
    where: `the folder ${f.root}, which holds the repositories ${f.repos.map((r) => `${r.name} (${r.path})`).join(", ")}`,
  };
}
