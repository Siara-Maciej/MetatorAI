/**
 * The change of a run and the notes on it, end to end (S5): the real `metator` on a real temp
 * repository. `review changes` lists the files with counts and one file's hunks; `review notes`
 * are added, sent as one review message and marked addressed; `metator open` runs the editor of
 * `editor.command` (a script here) with `--goto`; the daemon serves the same.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, E2E_STATE_DIR, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const WORKFLOW =
  "kind: Workflow\nschemaVersion: 2\nid: demo\nstages:\n  - id: build\n    owner: mt-implementer\n";

let repo: ScratchRepo;
let configDir: string;
let env: Record<string, string>;
let runId = "";
type Data = Record<string, unknown>;
const mt = (...args: string[]) => metator(args, repo.root, env);
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  configDir = await mkdtemp(join(tmpdir(), "metator-e2e-config-"));
  env = { METATOR_CONFIG_DIR: configDir };
  await repo.write(".gitignore", ".metator/\n");
  await repo.write(".github/metator/workflows/demo.yml", WORKFLOW);
  await repo.write(
    "src/invoice.ts",
    "export function round2(n: number) {\n  return Math.round(n * 100) / 100;\n}\n",
  );
  await repo.commit("init");
  // The editor: a script that writes its arguments down.
  await repo.write("fake-editor.sh", `#!/bin/sh\necho "$@" >> "${configDir}/editor-calls.txt"\n`);
  await chmod(join(repo.root, "fake-editor.sh"), 0o755);
  expect(
    (await mt("config", "set", "editor.command", join(repo.root, "fake-editor.sh"), "--scope", "user")).code,
  ).toBe(0);
  runId = data(await mt("run", "init", "--workflow", "demo", "--task", "Round negatives")).runId as string;
  // The change: a line changed, a file added.
  await repo.write(
    "src/invoice.ts",
    "export function round2(n: number) {\n  const sign = n < 0 ? -1 : 1;\n  return (sign * Math.round(Math.abs(n) * 100)) / 100;\n}\n",
  );
  await repo.write("src/invoice.test.ts", "// tests\n");
});
afterAll(async () => {
  await repo.dispose();
  await rm(configDir, { recursive: true, force: true });
});

describe("metator review changes|notes and open (real CLI)", () => {
  test("the change as files and hunks; notes added, sent as one review message, addressed by a reply; the editor at a line", async () => {
    const changes = data(await mt("review", "changes", "--run", runId, "--file", "src/invoice.ts")) as {
      base: string;
      files: { path: string; added: number; removed: number; status: string }[];
      diff: { hunks: { lines: { kind: string }[] }[] };
    };
    expect(changes.base).toBe("HEAD");
    expect(changes.files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["fake-editor.sh", "added", 2, 0],
      ["src/invoice.test.ts", "added", 1, 0],
      ["src/invoice.ts", "modified", 2, 1],
    ]);
    expect(changes.diff.hunks[0]?.lines.filter((l) => l.kind === "add")).toHaveLength(2);
    const a = data(
      await mt(
        "review",
        "notes",
        "add",
        "half-down for negatives?",
        "--run",
        runId,
        "--file",
        "src/invoice.ts",
        "--line",
        "2",
        "--side",
        "new",
        "--by",
        "maciej",
      ),
    );
    expect(a).toMatchObject({ id: "n001", status: "draft", file: "src/invoice.ts", line: 2 });
    expect(
      (await mt("review", "notes", "add", "tests for 1000.00", "--run", runId, "--by", "maciej")).code,
    ).toBe(0);
    expect(JSON.parse(await repo.read(`.metator/runs/${runId}/review/notes.json`))).toMatchObject({
      kind: "ReviewNotes",
      schemaVersion: 1,
    });
    const sent = data(await mt("review", "notes", "send", "--run", runId, "--by", "maciej")) as {
      message: { id: string; topic: string };
      notes: Data[];
    };
    expect([sent.message.topic, sent.notes.length]).toEqual(["review", 2]);
    const messages = data(await mt("run", "messages", "--run", runId)) as {
      messages: { topic: string; text: string; refs: string[] }[];
    };
    expect(messages.messages.map((m) => [m.topic, m.refs])).toEqual([["review", ["src/invoice.ts"]]]);
    expect(messages.messages[0]?.text).toContain("- src/invoice.ts:2: half-down for negatives?");
    // The agent replies on the message: the notes read as addressed; a person reopens one.
    expect(
      (
        await mt(
          "run",
          "message",
          runId,
          "--from",
          runId,
          "--topic",
          "review-reply",
          "--text",
          "rounded half-down",
          "--ref",
          sent.message.id,
          "--by",
          "mt-implementer-1",
        )
      ).code,
    ).toBe(0);
    const listed = data(await mt("review", "notes", "list", "--run", runId)) as {
      notes: { id: string; status: string }[];
    };
    expect(listed.notes.map((n) => n.status)).toEqual(["addressed", "addressed"]);
    expect(
      data(await mt("review", "notes", "status", "n002", "--set", "draft", "--run", runId)),
    ).toMatchObject({ status: "draft" });
    // The editor: the repository (no worktree), the file at its line.
    const opened = data(await mt("open", "--run", runId, "--file", "src/invoice.ts", "--line", "2")) as {
      argv: string[];
      dir: string;
    };
    expect(opened.dir).toBe(repo.root);
    // Not VS Code: the file alone (VS Code and its forks get the directory and --goto file:line).
    expect(opened.argv.slice(1)).toEqual([`${repo.root}/src/invoice.ts`]);
    const calls = await readFile(join(configDir, "editor-calls.txt"), "utf8").catch(() => "");
    expect(calls).toContain(`${repo.root}/src/invoice.ts`);
    const activity = data(await mt("run", "activity", "--run", runId)) as {
      entries: { text: string; origin?: string }[];
    };
    expect(
      activity.entries.some(
        (e) => e.origin === "inbox" && e.text === "opened in the editor: src/invoice.ts:2",
      ),
    ).toBe(true);
  }, 60_000);

  test("the daemon serves the change, the notes and the editor", async () => {
    const daemon = Bun.spawn(
      ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"],
      {
        cwd: repo.root,
        env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const reader = daemon.stderr.getReader();
      let text = "";
      let base = "";
      const deadline = Date.now() + 20_000;
      while (!base && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        const line = text.split("\n").find((l) => l.includes('"serving"'));
        if (line) base = (JSON.parse(line) as { serving: { url: string } }).serving.url;
      }
      expect(base).not.toBe("");
      const call = async (path: string, body?: unknown) =>
        (await (
          await fetch(
            `${base}${path}`,
            body
              ? {
                  method: "POST",
                  body: JSON.stringify(body),
                  headers: { "content-type": "application/json" },
                }
              : {},
          )
        ).json()) as { ok: boolean; data: Data; error?: Data };
      const review = await call(`/runs/${runId}/review?file=src/invoice.ts`);
      expect((review.data.files as Data[]).map((f) => f.path)).toEqual([
        "fake-editor.sh",
        "src/invoice.test.ts",
        "src/invoice.ts",
      ]);
      expect((review.data.diff as { hunks: unknown[] }).hunks).toHaveLength(1);
      const added = await call(`/runs/${runId}/review-notes`, {
        file: "src/invoice.test.ts",
        line: 1,
        side: "new",
        text: "a real test",
        by: "maciej",
      });
      expect(added.data).toMatchObject({ id: "n003", status: "draft" });
      const sent = await call(`/runs/${runId}/review-send`, { by: "maciej" });
      expect((sent.data.notes as Data[]).map((n) => n.id)).toEqual(["n002", "n003"]);
      const notes = await call(`/runs/${runId}/review-notes`);
      expect((notes.data.notes as Data[]).map((n) => n.status)).toEqual(["addressed", "sent", "sent"]);
      expect(
        (await call(`/runs/${runId}/review-note-status`, { id: "n003", status: "addressed" })).data,
      ).toMatchObject({ status: "addressed" });
      const opened = await call(`/runs/${runId}/open-editor`, { file: "src/invoice.ts", line: 3 });
      expect((opened.data.argv as string[]).at(-1)).toBe(`${repo.root}/src/invoice.ts`);
      expect((await call(`/runs/${runId}/review-send`, { by: "maciej" })).ok).toBe(false);
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
  }, 60_000);
});
