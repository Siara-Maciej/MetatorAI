import {
  err,
  FOLDER_PLACE,
  type FolderChat,
  type ListedThread,
  MetatorError,
  ok,
  type Result,
  type RunOverview,
  type ThreadNode,
  type ThreadTree,
  threadTreeOf,
} from "@metator/core";
import type { MetatorContainer } from "@metator/runtime";
import { z } from "zod";
import { body, type Call, type Daemon, optional, type Route, route, text } from "../http.ts";

/**
 * `/threads` (ADR-0095): one thread per topic, with its chat terminal. The tree the sidebar draws
 * (threads → their tasks, "Without a chat", "Closed"), a new thread with its chat pane, and a
 * thread's summary, close and reopen. In a folder every repository's threads come together.
 */

interface Served {
  readonly name?: string;
  readonly c: MetatorContainer;
}

/** The repositories a call reads: the one it names (by name or root), else every one the daemon serves. */
function servedBy({ daemon, repo }: Pick<Call, "daemon" | "repo">): readonly Served[] {
  const all = daemon.places();
  if (!repo || !daemon.folder) return all;
  return all.filter((r) => r.name === repo || r.c.resolve("root") === repo);
}

/** The tree over the repositories a call reads, their runs as the state socket read them. */
async function treeOf(
  call: Pick<Call, "daemon" | "repo">,
): Promise<Result<ThreadTree<ListedThread>, MetatorError>> {
  const views = await call.daemon.overviews(false);
  return threadTreeOf(
    servedBy(call).map((r) => {
      // The folder's own place has threads and no runs; a repository whose runs cannot be read
      // now still shows its threads.
      const overview = views.find((v) => v.c === r.c)?.overview;
      return {
        ...(r.name ? { repo: r.name } : {}),
        threads: r.c.resolve("threads"),
        runs: overview?.isOk() ? overview.value.runs : ([] as RunOverview[]),
      };
    }),
  );
}

/** The repository that holds a thread: the one the call names, else the first that has it. */
async function holder(
  call: Pick<Call, "daemon" | "repo">,
  id: string,
): Promise<Result<Served, MetatorError>> {
  for (const r of servedBy(call)) if ((await r.c.resolve("threads").show(id)).isOk()) return ok(r);
  return (await (servedBy(call)[0] as Served).c.resolve("threads").show(id)).map(
    () => servedBy(call)[0] as Served,
  );
}

/** One thread as the tree has it: with its tasks and its chat. */
async function nodeOf(
  call: Pick<Call, "daemon" | "repo">,
  id: string,
): Promise<Result<ThreadNode<ListedThread>, MetatorError>> {
  const tree = await treeOf(call);
  if (tree.isErr()) return err(tree.error);
  const node = [...tree.value.threads, ...tree.value.closed].find((t) => t.id === id);
  return node
    ? ok(node)
    : err(MetatorError.notFound(`thread ${id}`, { hint: "List them: `metator thread list`." }));
}

/** The name a folder gives the repository of a container. */
const nameOf = (daemon: Daemon, c: MetatorContainer): string | undefined =>
  daemon.folder ? daemon.places().find((r) => r.c === c)?.name : undefined;

/**
 * What makes a chat the folder's own (ADR-0113), when the call is for the folder itself: its
 * repositories by name, after the conversation agent's host files were copied from them into the
 * folder (the host starts there and reads its agents there).
 */
async function folderChat(
  daemon: Daemon,
  c: MetatorContainer,
): Promise<Result<FolderChat | undefined, MetatorError>> {
  if (!daemon.folder || nameOf(daemon, c) !== FOLDER_PLACE) return ok(undefined);
  const adopted = await c.resolve("adoptChatAgent")(daemon.repos().map((r) => r.c.resolve("fileSystem")));
  if (adopted.isErr()) return err(adopted.error);
  return ok({ repos: daemon.folder.repos.map((r) => r.name) });
}

const by = body({ by: text });

export const THREAD_ROUTES: readonly Route[] = [
  route({ method: "GET", pattern: "/threads", global: true, handler: (call) => treeOf(call) }),
  route({
    method: "GET",
    pattern: "/threads/:id",
    global: true,
    handler: (call) => nodeOf(call, call.params.id as string),
  }),
  // A new thread and its chat terminal ("+ New chat", or the agent's `metator thread new` from its pane).
  route({
    method: "POST",
    pattern: "/threads",
    body: body({
      title: optional(z.string()),
      by: text,
      host: optional(z.string()),
      carry: optional(z.string()),
      from: optional(z.looseObject({ issue: optional(z.string()), thread: optional(z.string()) })),
    }),
    handler: async ({ c, token, daemon, body: b }) => {
      const caller = token ? await c.resolve("panes").authorize(token) : undefined;
      const repo = nameOf(daemon, c);
      const folder = await folderChat(daemon, c);
      if (folder.isErr()) return folder;
      const from = {
        ...(b.from?.issue ? { issue: b.from.issue } : {}),
        ...(b.from?.thread ? { thread: b.from.thread } : {}),
      };
      return c.resolve("threads").create({
        ...(b.title ? { title: b.title } : {}),
        by: b.by ?? "",
        ...(b.host ? { host: b.host } : {}),
        ...(b.carry ? { carry: b.carry } : {}),
        ...(Object.keys(from).length > 0 ? { from } : {}),
        ...(caller ? { caller } : {}),
        ...(repo ? { repo } : {}),
        ...(folder.value ? { folder: folder.value } : {}),
      });
    },
  }),
  route({
    method: "POST",
    pattern: "/threads/:id/summary",
    global: true,
    body: body({ text, title: optional(z.string()) }),
    handler: async (call) => {
      const id = call.params.id as string;
      const where = await holder(call, id);
      if (where.isErr()) return where;
      return (
        await where.value.c.resolve("threads").summary({
          id,
          text: call.body.text ?? "",
          ...(call.body.title ? { title: call.body.title } : {}),
        })
      ).map((thread) => ({ thread }));
    },
  }),
  route({
    method: "POST",
    pattern: "/threads/:id/close",
    global: true,
    body: by,
    handler: async (call) => {
      const id = call.params.id as string;
      const where = await holder(call, id);
      if (where.isErr()) return where;
      return where.value.c.resolve("threads").close({ id, by: call.body.by ?? "" });
    },
  }),
  route({
    method: "POST",
    pattern: "/threads/:id/reopen",
    global: true,
    body: body({ by: text, host: optional(z.string()) }),
    handler: async (call) => {
      const id = call.params.id as string;
      const where = await holder(call, id);
      if (where.isErr()) return where;
      const folder = await folderChat(call.daemon, where.value.c);
      if (folder.isErr()) return folder;
      return where.value.c.resolve("threads").reopen({
        id,
        by: call.body.by ?? "",
        ...(call.body.host ? { host: call.body.host } : {}),
        ...(where.value.name ? { repo: where.value.name } : {}),
        ...(folder.value ? { folder: folder.value } : {}),
      });
    },
  }),
];
