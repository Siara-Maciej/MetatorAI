import type { AgentEvent, AgentHost, AgentTask } from "@metator/core";

/**
 * AgentHost on GitHub Copilot CLI (ADR-0051): `copilot -p … --agent <id> --output-format json`
 * in the run's worktree. Prompt mode cannot ask a person, so the drive's STATUS: blocked line is
 * how a Copilot worker asks; git push stays denied at the process level, hooks still apply.
 */
export class CopilotAgentHost implements AgentHost {
  readonly id = "copilot";

  constructor(private readonly bin: string = "copilot") {}

  async *run(task: AgentTask): AsyncIterable<AgentEvent> {
    const session = task.resume ?? crypto.randomUUID();
    yield { type: "session", id: session };
    const argv = [
      this.bin,
      "-p",
      task.prompt,
      "--agent",
      task.agent,
      "-C",
      task.cwd,
      "--add-dir",
      task.runDir,
      "--output-format",
      "json",
      ...(task.resume ? ["--resume", task.resume] : ["--session-id", session]),
      "--allow-all-tools",
      "--deny-tool",
      "shell(git push)",
    ];
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, { cwd: task.cwd, stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      yield { type: "result", ok: false, text: `cannot start ${this.bin}: ${(e as Error).message}` };
      return;
    }
    const texts: string[] = [];
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        for (const event of parseLine(line)) {
          if (event.type === "text") texts.push(event.text);
          yield event;
        }
        nl = buffer.indexOf("\n");
      }
    }
    for (const event of parseLine(buffer.trim())) {
      if (event.type === "text") texts.push(event.text);
      yield event;
    }
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    yield {
      type: "result",
      ok: code === 0,
      text: code === 0 ? texts.join("\n") : `${this.bin} exited ${code}: ${stderr.trim().slice(-500)}`,
    };
  }
}

/**
 * One line of Copilot's JSONL output as events. The format is read tolerantly: a message's text
 * from `content`/`text`, a tool from `toolName`/`name`; anything else is skipped, never fatal.
 */
export function parseLine(line: string): AgentEvent[] {
  if (line === "") return [];
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [{ type: "text", text: line }];
  }
  const data = (typeof o.data === "object" && o.data !== null ? o.data : o) as Record<string, unknown>;
  const type = String(o.type ?? "");
  const tool = data.toolName ?? data.tool ?? (type.includes("tool") ? data.name : undefined);
  if (typeof tool === "string") {
    const args = data.arguments ?? data.input ?? data.args;
    return [{ type: "tool", name: tool, summary: JSON.stringify(args ?? {}).slice(0, 200) }];
  }
  const text = data.content ?? data.text ?? data.message;
  if (typeof text === "string" && text.trim() !== "" && !type.includes("user"))
    return [{ type: "text", text }];
  return [];
}
