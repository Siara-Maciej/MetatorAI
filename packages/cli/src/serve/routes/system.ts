import { z } from "zod";
import { body, flag, optional, type Route, route, text } from "../http.ts";
import { personOnly } from "./plans.ts";

/**
 * `/system/map` and `/system/discover`: the system map a person reads, changes and has proposed
 * from the code (ADR-0087). In a folder, discovery reads every repository of it and the map is
 * the named repository's (`?repo=`).
 */
export const SYSTEM_ROUTES: readonly Route[] = [
  route({
    method: "GET",
    pattern: "/system/map",
    handler: (call) => call.c.resolve("systemMaps").view(),
  }),
  route({
    method: "PUT",
    pattern: "/system/map",
    body: body({ map: z.unknown(), digest: z.string().nullable(), by: text, note: optional(z.string()) }),
    guard: personOnly,
    handler: (call) =>
      call.c.resolve("systemMaps").save({
        map: call.body.map,
        digest: call.body.digest,
        by: call.body.by ?? "",
        ...(call.body.note ? { note: call.body.note } : {}),
      }),
  }),
  route({
    method: "POST",
    pattern: "/system/discover",
    body: body({ write: flag, by: optional(z.string()) }),
    guard: async (call) => (call.body.write === true ? personOnly(call) : undefined),
    handler: (call) => {
      const folder = call.daemon.folder;
      return call.c.resolve("systemMaps").discover({
        write: call.body.write === true,
        ...(call.body.by ? { by: call.body.by } : {}),
        ...(folder ? { folder: { root: folder.root, repos: folder.repos.map((r) => r.root) } } : {}),
      });
    },
  }),
];
