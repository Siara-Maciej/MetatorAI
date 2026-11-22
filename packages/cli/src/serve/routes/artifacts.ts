import { type Call, type Route, route } from "../http.ts";

/**
 * `/runs/:run/artifacts` and `/runs/:run/artifact?path=`: the files of a run a person reads in the
 * app; only inside its run directory.
 */

const run = ({ params }: Call<unknown>) => params.run as string;

export const ARTIFACT_ROUTES: readonly Route[] = [
  route({
    method: "GET",
    pattern: "/runs/:run/artifacts",
    handler: (call) => call.c.resolve("runArtifacts").list(run(call)),
  }),
  // One artifact's content by its path in the run directory (F9): `?path=plan.json`.
  route({
    method: "GET",
    pattern: "/runs/:run/artifact",
    handler: (call) =>
      call.c.resolve("readRunArtifact").execute({ runId: run(call), path: call.query.get("path") ?? "" }),
  }),
  route({
    method: "GET",
    pattern: "/runs/:run/artifacts/:name+",
    handler: (call) => call.c.resolve("runArtifacts").read(run(call), call.params.name as string),
  }),
];
