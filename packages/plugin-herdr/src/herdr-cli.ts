import { err, type HerdrControl, type HerdrPaneStatus, MetatorError, ok, type Result } from "@metator/core";

/** The source MetatorAI reports metadata under in herdr; herdr's own sources start with `herdr:`. */
export const METADATA_SOURCE = "metator";

/**
 * HerdrControl on the herdr CLI (E2, ADR-0079): every call is one `herdr …` process that prints
 * one JSON answer, exactly as herdr's docs and agent skill use it. The CLI picks the session from
 * `HERDR_SESSION` or the default one; MetatorAI never talks to herdr's socket directly.
 */
export class HerdrCli implements HerdrControl {
  constructor(
    private readonly bin: string = "herdr",
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  async open(input: {
    readonly cwd: string;
    readonly label: string;
    readonly env: Readonly<Record<string, string>>;
  }): Promise<Result<{ readonly workspace: string; readonly pane: string }, MetatorError>> {
    const out = await this.json([
      "workspace",
      "create",
      "--cwd",
      input.cwd,
      "--label",
      input.label,
      "--no-focus",
      ...Object.entries(input.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    ]);
    if (out.isErr()) return err(out.error);
    const result = out.value.result as
      | { workspace?: { workspace_id?: unknown }; root_pane?: { pane_id?: unknown } }
      | undefined;
    const workspace = result?.workspace?.workspace_id;
    const pane = result?.root_pane?.pane_id;
    if (typeof workspace !== "string" || typeof pane !== "string")
      return err(
        new MetatorError("COMMAND_FAILED", "herdr workspace create answered without workspace and pane ids"),
      );
    return ok({ workspace, pane });
  }

  async run(pane: string, commandLine: string): Promise<Result<void, MetatorError>> {
    return (await this.json(["pane", "run", pane, commandLine])).map(() => undefined);
  }

  async status(pane: string): Promise<Result<HerdrPaneStatus, MetatorError>> {
    const out = await this.json(["pane", "get", pane], true);
    if (out.isErr()) return err(out.error);
    if (out.value.missing) return ok({ exists: false });
    const status = (out.value.result as { pane?: { agent_status?: unknown } } | undefined)?.pane
      ?.agent_status;
    return ok({
      exists: true,
      ...(typeof status === "string" && status !== "" ? { agentStatus: status } : {}),
    });
  }

  async report(
    pane: string,
    metadata: { readonly title: string; readonly tokens: Readonly<Record<string, string>> },
  ): Promise<Result<void, MetatorError>> {
    return (
      await this.json([
        "pane",
        "report-metadata",
        pane,
        "--source",
        METADATA_SOURCE,
        "--title",
        metadata.title,
        ...Object.entries(metadata.tokens).flatMap(([k, v]) => ["--token", `${k}=${v}`]),
      ])
    ).map(() => undefined);
  }

  async close(workspace: string): Promise<Result<void, MetatorError>> {
    return (await this.json(["workspace", "close", workspace])).map(() => undefined);
  }

  /**
   * One herdr call: its JSON answer, or `missing` when herdr says the target is not found (only
   * when `notFoundIsAnswer`). A failure keeps herdr's own error code and message.
   */
  private async json(
    args: readonly string[],
    notFoundIsAnswer = false,
  ): Promise<Result<{ readonly result?: unknown; readonly missing?: true }, MetatorError>> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([this.bin, ...args], {
        env: { ...(this.env as Record<string, string>) },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      return err(
        new MetatorError("BIN_NOT_FOUND", `${this.bin} is not available: ${(e as Error).message}`, {
          hint: "Install herdr (https://herdr.dev/docs/install/), or set METATOR_HERDR_BIN.",
        }),
      );
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const problem = herdrError(stderr) ?? herdrError(stdout);
      if (
        notFoundIsAnswer &&
        problem &&
        /not[_ ]found|unknown pane|no such/i.test(`${problem.code} ${problem.message}`)
      )
        return ok({ missing: true });
      return err(
        new MetatorError(
          "COMMAND_FAILED",
          `herdr ${args.slice(0, 2).join(" ")} failed: ${problem ? `${problem.code}: ${problem.message}` : stderr.trim() || `exit ${code}`}`,
          { hint: "Is the herdr server running for this session? `herdr status` says." },
        ),
      );
    }
    const text = stdout.trim();
    if (text === "") return ok({});
    try {
      return ok(JSON.parse(text.split("\n").at(-1) as string) as { result?: unknown });
    } catch {
      return ok({});
    }
  }
}

/** herdr's JSON error (`{"error":{"code","message"}}`), when the text is one. */
export function herdrError(text: string): { code: string; message: string } | undefined {
  for (const line of text.trim().split("\n").reverse()) {
    try {
      const o = JSON.parse(line) as { error?: { code?: unknown; message?: unknown } };
      if (o.error && typeof o.error.code === "string")
        return { code: o.error.code, message: typeof o.error.message === "string" ? o.error.message : "" };
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}
