import {
  type ComposeService,
  type ContainerRuntime,
  err,
  MetatorError,
  ok,
  type ProcessRunner,
  type Result,
} from "@metator/core";

const EXTERNAL_NETWORK = /network ([\w.-]+) declared as external, but could not be found/;

/**
 * ContainerRuntime on `docker compose` (ADR-0053): `up -d`, `stop` and `logs` of one service,
 * each one process through the ProcessRunner. No time limit: an `up` may pull images.
 */
export class DockerComposeRuntime implements ContainerRuntime {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly bin: string = "docker",
  ) {}

  async up(s: ComposeService): Promise<Result<void, MetatorError>> {
    const first = await this.compose(s, ["up", "-d", s.service]);
    // An external network compose expects to exist (a README's `docker network create x`): create
    // it, as a person would, and start once more.
    const missing = first.isErr() ? EXTERNAL_NETWORK.exec(first.error.message)?.[1] : undefined;
    if (!missing) return first.map(() => undefined);
    const created = await this.run(s, [this.bin, "network", "create", missing]);
    if (created.isErr()) return err(created.error);
    return (await this.compose(s, ["up", "-d", s.service])).map(() => undefined);
  }

  async stop(s: ComposeService): Promise<Result<void, MetatorError>> {
    return (await this.compose(s, ["stop", s.service])).map(() => undefined);
  }

  async logs(s: ComposeService, lines: number): Promise<Result<string, MetatorError>> {
    return this.compose(s, ["logs", "--no-color", "--tail", String(lines), s.service]);
  }

  private compose(s: ComposeService, args: readonly string[]): Promise<Result<string, MetatorError>> {
    return this.run(s, [this.bin, "compose", "-p", s.project, "-f", s.file, ...args]);
  }

  private async run(s: ComposeService, argv: readonly string[]): Promise<Result<string, MetatorError>> {
    const r = await this.runner.run({ argv, cwd: s.cwd, env: s.env });
    // The runner's exit code of a program that cannot be started.
    if (r.exitCode === 127) {
      return err(
        new MetatorError("BIN_NOT_FOUND", `${this.bin} is not available: ${r.stderr.trim()}`, {
          hint: "Install Docker (with the compose plugin), or set METATOR_DOCKER_BIN.",
        }),
      );
    }
    if (r.exitCode !== 0) {
      return err(
        new MetatorError(
          "COMMAND_FAILED",
          `\`${argv.join(" ")}\` exited ${r.exitCode}: ${r.stderr.trim().slice(-500)}`,
        ),
      );
    }
    return ok(r.stdout);
  }
}
