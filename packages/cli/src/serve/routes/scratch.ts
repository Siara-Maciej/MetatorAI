import { body, type Route, route, strings, text } from "../http.ts";

/**
 * `/scratch` (ADR-0093): the direct edits not meant for a commit ("Debug changes") a repository
 * holds, and taking them out again. The count is on the state; the list is read when a person opens it.
 */
export const SCRATCH_ROUTES: readonly Route[] = [
  route({
    method: "GET",
    pattern: "/scratch",
    handler: async ({ c }) => (await c.resolve("scratch").list()).map((items) => ({ items })),
  }),
  route({
    method: "POST",
    pattern: "/scratch/drop",
    body: body({ ids: strings, by: text }),
    handler: ({ c, body: b }) =>
      c.resolve("scratch").drop({ ...(b.ids && b.ids.length > 0 ? { ids: b.ids } : {}), by: b.by ?? "" }),
  }),
];
