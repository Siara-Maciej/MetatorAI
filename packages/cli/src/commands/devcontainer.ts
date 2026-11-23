import { existsSync } from "node:fs";
import { err, MetatorError, ok, tunnelArgv } from "@metator/core";
import { devContainers } from "@metator/runtime";
import type { Command } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import { envWords, fromEnvelope, portOf, progress } from "../devcontainer.ts";
import { linuxBundlesDir } from "../installation.ts";

const CONTAINER = [
  "<container>",
  "the dev container: its local folder (the devcontainer.local_folder label), the folder's name, or the container's name or id",
] as const;
const BUNDLES = [
  "--bundles <dir>",
  "the Linux CLI bundles (<dir>/<arch>/metator-bundle.json; default: $METATOR_LINUX_BUNDLES, else the desktop app's)",
] as const;
const ENV = ["--env <name=value...>", "more variables for the program in the container"] as const;

/**
 * `metator devcontainer …` (ADR-0106), run on the person's computer: the dev containers its
 * docker or nerdctl knows, Start, the Linux CLI copied into one (per user, per version), and
 * `metator` (or another program) run there as the container's remote user, in its workspace
 * folder, with the environment its terminal has. The desktop app runs these; so can a person.
 */
export function registerDevcontainerCommands(program: Command, { action }: CommandContext): void {
  const group = program
    .command("devcontainer")
    .description(
      "Dev containers on this computer: list, start, install MetatorAI's Linux CLI into one, run it there",
    );
  const env = process.env;
  const engine = (bundles?: string) =>
    devContainers({ env, bundles: bundles ?? linuxBundlesDir(env, process.execPath, Bun.main, existsSync) });

  meta(group.command("list"), { audience: "person", folder: true })
    .description(
      "The dev containers docker (or nerdctl) knows: their local folder, state, workspace folder and user",
    )
    .action(action(async () => ({ result: await (await engine()).list() })));

  meta(group.command("start").argument(...CONTAINER), { audience: "person", folder: true })
    .description("Start a stopped dev container; answers it running")
    .action(action(async (container: string) => ({ result: await (await engine()).start(container) })));

  meta(group.command("install").argument(...CONTAINER), { audience: "person", folder: true })
    .description(
      "Copy MetatorAI's Linux CLI of the container's architecture into ~/.metator/server/<version>/ of its user, unless that version is there",
    )
    .option(...BUNDLES)
    .action(
      action(async (container: string, opts: { bundles?: string }) => {
        const done = await (await engine(opts.bundles)).install(container, progress);
        return { result: done.map(({ cli, at }) => ({ ...cli, container: at.container })) };
      }),
    );

  meta(
    group
      .command("run")
      .argument(...CONTAINER)
      .argument("[args...]", "metator's arguments, after --"),
    {
      audience: "person",
      folder: true,
    },
  )
    .description(
      "Run metator in the container (installed first when needed) and answer what it answered: `metator devcontainer run shop -- inspect . --json`",
    )
    .option("--cwd <dir>", "its folder in the container (default: the workspace folder)")
    .option(...ENV)
    .option(...BUNDLES)
    .action(
      action(
        async (
          container: string,
          args: string[],
          opts: { cwd?: string; env?: string[]; bundles?: string },
        ) => {
          const vars = envWords(opts.env ?? []);
          if (vars.isErr()) return { result: err(vars.error) };
          const ran = await (await engine(opts.bundles)).run(
            container,
            args,
            { ...(opts.cwd ? { cwd: opts.cwd } : {}), env: vars.value, stderr: "inherit" },
            progress,
          );
          if (ran.isErr()) return { result: err(ran.error) };
          return fromEnvelope(ran.value.result.stdout, ran.value.result.exitCode);
        },
      ),
    );

  meta(
    group
      .command("exec")
      .argument(...CONTAINER)
      .argument("<argv...>", "the program and its arguments, after --"),
    {
      audience: "person",
      folder: true,
    },
  )
    .description(
      "Run a program in the container as its user, in the workspace folder; answers its exit code and output",
    )
    .option("--cwd <dir>", "its folder in the container (default: the workspace folder)")
    .option(...ENV)
    .action(
      action(async (container: string, argv: string[], opts: { cwd?: string; env?: string[] }) => {
        const vars = envWords(opts.env ?? []);
        if (vars.isErr()) return { result: err(vars.error) };
        const ran = await (await engine()).exec(container, argv, {
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          env: vars.value,
        });
        return {
          result: ran.map((r) => ({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr })),
        };
      }),
    );

  meta(group.command("serve").argument(...CONTAINER), { audience: "person", folder: true })
    .description(
      "The daemon of a repository in the container (`serve --ensure` there, installed first when needed), and the command that tunnels a connection to it",
    )
    .option("--path <dir>", "the repository in the container (default: the workspace folder)")
    .option(...ENV)
    .option(...BUNDLES)
    .action(
      action(async (container: string, opts: { path?: string; env?: string[]; bundles?: string }) => {
        const vars = envWords(opts.env ?? []);
        if (vars.isErr()) return { result: err(vars.error) };
        const dc = await engine(opts.bundles);
        const info = dc.engineInfo();
        if (info.isErr()) return { result: err(info.error) };
        const ran = await dc.run(
          container,
          [...(opts.path ? ["-C", opts.path] : []), "serve", "--ensure", "--port", "0", "--json"],
          { ...(opts.path ? { cwd: opts.path } : {}), env: vars.value, stderr: "inherit" },
          progress,
        );
        if (ran.isErr()) return { result: err(ran.error) };
        const { result, cli, at } = ran.value;
        const answered = fromEnvelope(result.stdout, result.exitCode);
        if (answered.result.isErr()) return answered;
        const daemon = answered.result.value as { url?: string; pid?: number; started?: boolean };
        const port = portOf(daemon.url ?? "");
        if (port === undefined)
          return {
            result: err(
              new MetatorError(
                "COMMAND_FAILED",
                `the daemon in the container answered no address: ${result.stdout.trim()}`,
              ),
            ),
          };
        return {
          result: ok({
            url: daemon.url,
            port,
            pid: daemon.pid,
            started: daemon.started,
            tunnel: tunnelArgv(info.value, at.container, cli.path, port),
            container: at.container,
            cli,
          }),
          warnings: answered.warnings,
        };
      }),
    );
}
