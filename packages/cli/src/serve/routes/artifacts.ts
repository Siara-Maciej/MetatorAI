import { type Call, type Route, route } from "../http.ts";

/** `/runs/:run/artifacts`: the files of a run a person reads in the app; only inside its run directory. */

const run = ({ params }: Call<unknown>) => params.run as string;

export const ARTIFACT_ROUTES: readonly Route[] = [
  route({
    method: "GET",
    pattern: "/runs/:run/artifacts",
    handler: (call) => call.c.resolve("runArtifacts").list(run(call)),
  }),
  route({
    method: "GET",
    pattern: "/runs/:run/artifacts/:name+",
    handler: (call) => call.c.resolve("runArtifacts").read(run(call), call.params.name as string),
  }),
];
