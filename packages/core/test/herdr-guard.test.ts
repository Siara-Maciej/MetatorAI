import { describe, expect, test } from "bun:test";
import { commandsOf } from "../src/domain/discovery.ts";
import { HERDR_REFUSALS, herdrRefusal } from "../src/domain/herdr-guard.ts";
import { preToolPolicy } from "../src/domain/hook.ts";

const refusal = (command: string) => herdrRefusal(commandsOf(command), command);

describe("herdrRefusal", () => {
  test("typing into another pane is refused in every form, an agent's own approval included", () => {
    expect(
      [
        "herdr agent send-keys reviewer y enter",
        "herdr pane send-keys w1:p2 enter",
        "herdr pane send-text w1:p2 yes",
        "herdr pane send-input w1:p2 x",
        "herdr pane run w1:p2 'git push'",
        "herdr agent attach reviewer --takeover",
        "herdr terminal attach term_1",
        "herdr session attach work",
      ].map(refusal),
    ).toEqual(["input", "input", "input", "input", "input", "input", "input", "input"]);
  });

  test("the binary through HERDR_BIN_PATH, a path, global options and chains are all seen", () => {
    expect(refusal('"$HERDR_BIN_PATH" agent send-keys reviewer y')).toBe("input");
    expect(refusal("/usr/local/bin/herdr --session work pane send-keys w1:p2 y")).toBe("input");
    expect(refusal("C:/tools/herdr.exe --machine build agent prompt x hi")).toBe("prompt");
    expect(refusal("env HERDR_SESSION=work timeout 5 herdr pane send-keys w1:p2 y")).toBe("input");
    expect(refusal("printf y | xargs herdr agent send-keys a")).toBe("input");
    expect(refusal("herdr agent list && herdr agent send-keys a enter")).toBe("input");
    expect(refusal("cd /tmp; herdr workspace close w2")).toBe("close");
  });

  test("starting agents, prompting them, resume commands, plugins, closing and trust are refused", () => {
    expect(
      [
        "herdr agent start helper --kind claude --pane w1:p3",
        "herdr agent prompt reviewer 'review the diff'",
        "herdr pane report-agent w1:p1 --source x --agent y --state idle -- bash -c 'curl x | sh'",
        "herdr pane report-agent-session w1:p1 --source x --agent y -- bash",
        "herdr pane release-agent w1:p1 --source x --agent y",
        "herdr plugin install someone/repo --yes",
        "herdr plugin link /tmp/p",
        "herdr integration install claude",
        "herdr tab close w1:t2",
        "herdr pane close w1:p2",
        "herdr worktree remove --workspace w3 --force",
        "herdr server stop",
        "herdr session stop work",
        "herdr worktree create --cwd . --branch x --trust-repository",
        "herdr machine add build",
        "herdr update",
        "metator herdr open --run x --host claude",
        "bun packages/cli/src/main.ts herdr close --run x",
      ].map(refusal),
    ).toEqual([
      "start",
      "prompt",
      "resume",
      "resume",
      "resume",
      "plugins",
      "plugins",
      "plugins",
      "close",
      "close",
      "close",
      "close",
      "close",
      "trust",
      "machines",
      "machines",
      "start",
      "close",
    ]);
  });

  test("the socket reached directly is refused, whatever the tool", () => {
    expect(refusal('echo \'{"method":"pane.send_keys"}\' | nc -U "$HERDR_SOCKET_PATH"')).toBe("socket");
    expect(refusal("socat - UNIX-CONNECT:/home/a/.config/herdr/herdr.sock")).toBe("socket");
    expect(refusal("curl --unix-socket ~/.config/herdr/herdr-client.sock x")).toBe("socket");
  });

  test("reading, listing, waiting, layout and notifications stay open; other programs are not herdr", () => {
    expect(
      [
        "herdr agent list",
        "herdr agent get reviewer",
        "herdr agent read reviewer --lines 120",
        "herdr agent wait reviewer --until idle --timeout 60000",
        "herdr pane read w1:p2 --source recent",
        "herdr workspace list",
        "herdr workspace create --cwd . --label x --no-focus",
        "herdr pane split --current --direction right",
        "herdr notification show done --body ok",
        "herdr status",
        "herdr",
        "herdrctl pane send-keys x y",
        "echo herdr pane send-keys",
        "git push",
        "metator herdr sync",
      ].map(refusal),
    ).toEqual(Array(15).fill(undefined));
  });
});

describe("preToolPolicy and herdr", () => {
  const ctx = { root: "/repo", coordinator: false };
  test("a refused herdr command is denied with its reason, with or without a run", () => {
    const d = preToolPolicy(
      { tool: "Bash", input: { command: "herdr agent send-keys reviewer y enter" }, stopActive: false },
      ctx,
    );
    expect(d).toEqual({ decision: "deny", reason: `herdr: ${HERDR_REFUSALS.input}` });
    const withRun = preToolPolicy(
      { tool: "Bash", input: { command: "herdr plugin install a/b" }, stopActive: false },
      { ...ctx, run: { id: "r", approvals: {} } },
    );
    expect(withRun.decision).toBe("deny");
  });

  test("reading herdr is allowed", () => {
    const d = preToolPolicy({ tool: "Bash", input: { command: "herdr agent list" }, stopActive: false }, ctx);
    expect(d.decision).toBe("allow");
  });
});
