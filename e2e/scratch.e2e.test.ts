/**
 * Scratch (ADR-0093), with the real `metator` process on a real repository: a direct edit not
 * meant for a commit is recorded as a patch (`scratch begin` / `scratch end`), listed, and taken
 * out again (`scratch drop`), also through the daemon (`GET /scratch`, `POST /scratch/drop`, the
 * count on `/state`); a patch that no longer applies is reported and never forced; a commit that
 * would hold a recorded change is stopped by the commit guard until the person says to commit anyway.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLI_ENTRY, E2E_STATE_DIR, hook, metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let repo: ScratchRepo;
let daemon: Bun.Subprocess<"ignore", "pipe", "pipe">;
let base = "";
type Data = Record<string, unknown>;
const env = { METATOR_USER: "ana" };
const mt = (...args: string[]) => metator(args, repo.root, env);
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const error = (r: { json: Record<string, unknown> }) => r.json.error as { code: string; message: string };
const api = async (path: string, init?: RequestInit) =>
  (await (await fetch(`${base}${path}`, init)).json()) as { ok: boolean; data: Data; error?: Data };
const decision = (r: { json: Record<string, unknown> | null }) =>
  r.json?.hookSpecificOutput as
    | { permissionDecision?: string; permissionDecisionReason?: string }
    | undefined;
const PRICE = "export const price = (n: number) => n;\n";
const TAX = "export const tax = (n: number) => n * 0.23;\n";
/** A scratch edit: begin, write the files, end with a note. */
async function scratchEdit(files: Record<string, string>, note: string): Promise<string> {
  expect((await mt("scratch", "begin")).code).toBe(0);
  for (const [path, text] of Object.entries(files)) await repo.write(path, text);
  const ended = data(await mt("scratch", "end", "--note", note)) as { recorded: { id: string } };
  return ended.recorded.id;
}

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\n");
  await repo.write("src/price.ts", PRICE);
  await repo.write("src/tax.ts", TAX);
  await repo.commit("init");
  daemon = Bun.spawn(["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0"], {
    cwd: repo.root,
    env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = daemon.stderr.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.includes('"serving"'));
    if (line) {
      base = (JSON.parse(line) as { serving: { url: string } }).serving.url;
      break;
    }
  }
}, 60_000);
afterAll(async () => {
  daemon.kill("SIGTERM");
  await daemon.exited;
  await repo.dispose();
});

describe("metator scratch: changes not meant for a commit", () => {
  test("begin, edit, end: one record with its files and note; work in progress is not part of it; list and the state's count", async () => {
    // Real work in progress, before the debug edit.
    await repo.write("src/tax.ts", `${TAX}export const VAT = 0.23;\n`);
    expect(((await api("/state")).data as { scratch: number }).scratch).toBe(0);
    const id = await scratchEdit(
      { "src/price.ts": `${PRICE}console.log("price called");\n`, "debug.log": "trace\n" },
      "trace price calls",
    );
    expect(id).toBe("s001");
    const listed = data(await mt("scratch", "list")) as { items: Data[] };
    expect(listed.items).toMatchObject([
      { id: "s001", files: ["debug.log", "src/price.ts"], note: "trace price calls" },
    ]);
    const record = JSON.parse(await repo.read(".metator/scratch/s001.json")) as Data;
    expect(record).toMatchObject({ kind: "ScratchRecord", schemaVersion: 1, id: "s001" });
    expect(String(record.patch)).toContain('+console.log("price called");');
    expect(String(record.patch)).not.toContain("VAT");
    // The daemon: the count on the state, the list on its own route.
    expect(((await api("/state")).data as { scratch: number }).scratch).toBe(1);
    const served = (await api("/scratch")).data as { items: Data[] };
    expect(served.items).toEqual(listed.items);
    // Usage: an edit must be open to end it; one at a time.
    expect(error(await mt("scratch", "end")).message).toBe(
      "no scratch edit is open: begin one first (`metator scratch begin`)",
    );
  }, 60_000);

  test("the commit guard: a commit that holds a recorded change is stopped with the files; the person's word lets it through once", async () => {
    const pane = { METATOR_PANE_ID: "w1:p1" };
    const commit = (command: string) =>
      hook(
        ["guard", "pre-tool"],
        { tool_name: "Bash", tool_input: { command }, session_id: "s1" },
        repo.root,
        pane,
      );
    // Nothing of it is staged: an ordinary commit asks as every commit does.
    await repo.git("add", "src/tax.ts");
    expect(decision(await commit("git commit -m 'Add VAT'"))?.permissionDecisionReason).toBe(
      '`git commit -m Add VAT` needs your consent: answer here, or say it in the chat ("commit").',
    );
    // The bypass a real agent found: add and commit in ONE call. Nothing of the debug change is
    // staged when the hook is asked, yet that commit would take it. The whole line is read.
    const chained = 'git add src/price.ts && git commit -m "Log the sku in the GET /prices handler"';
    const stopped =
      "this commit holds debug changes: src/price.ts. Remove them first (`metator scratch drop`), or answer here to commit anyway.";
    const first = decision(await commit(chained));
    expect([first?.permissionDecision, first?.permissionDecisionReason]).toEqual(["ask", stopped]);
    // Also when the person's word for a commit is there: "commit" is no consent to commit debug lines.
    await hook(["guard", "user-prompt"], { prompt: "commit it", session_id: "s1" }, repo.root, pane);
    const withWord = decision(await commit(chained));
    expect([withWord?.permissionDecision, withWord?.permissionDecisionReason]).toEqual(["ask", stopped]);
    // `git add -A` takes the new debug file too; a `cd` says where the paths are.
    expect(decision(await commit("git add -A && git commit -m x"))?.permissionDecisionReason).toContain(
      "this commit holds debug changes: debug.log, src/price.ts.",
    );
    expect(
      decision(await commit("cd src; git add price.ts; git commit -m x"))?.permissionDecisionReason,
    ).toBe(stopped);
    // Adding only the real work is an ordinary commit (the word given above lets it through, once).
    expect(decision(await commit("git add src/tax.ts && git commit -m 'Add VAT'"))?.permissionDecision).toBe(
      "allow",
    );
    // `commit -a` would take the debug line; so would staging it.
    const all = decision(await commit("git commit -am 'Add VAT'"));
    expect([all?.permissionDecision, all?.permissionDecisionReason]).toEqual([
      "ask",
      "this commit holds debug changes: src/price.ts. Remove them first (`metator scratch drop`), or answer here to commit anyway.",
    ]);
    await repo.git("add", "src/price.ts");
    expect(decision(await commit("git commit -m 'Add VAT'"))?.permissionDecisionReason).toContain(
      "this commit holds debug changes: src/price.ts.",
    );
    // "commit" alone is consent to commit, not to commit debug changes.
    await hook(["guard", "user-prompt"], { prompt: "commit", session_id: "s1" }, repo.root, pane);
    expect(decision(await commit("git commit -m 'Add VAT'"))?.permissionDecision).toBe("ask");
    await hook(["guard", "user-prompt"], { prompt: "commit anyway", session_id: "s1" }, repo.root, pane);
    expect(decision(await commit("git commit -m 'Add VAT'"))?.permissionDecision).toBe("allow");
    await repo.git("reset", "-q");
  }, 60_000);

  test("drop takes the change out again and leaves the work in progress; through the daemon too", async () => {
    const second = await scratchEdit(
      { "src/tax.ts": `${TAX}export const VAT = 0.23;\nconsole.log("tax");\n` },
      "trace tax",
    );
    expect(second).toBe("s002");
    const dropped = await api("/scratch/drop", {
      method: "POST",
      body: JSON.stringify({ ids: ["s002"], by: "ana" }),
    });
    expect(dropped.data).toEqual({ dropped: [{ id: "s002", files: ["src/tax.ts"] }], failed: [], gone: [] });
    expect(await repo.read("src/tax.ts")).toBe(`${TAX}export const VAT = 0.23;\n`);
    const all = data(await mt("scratch", "drop", "--all")) as {
      dropped: { id: string }[];
      failed: unknown[];
    };
    expect([all.dropped.map((d) => d.id), all.failed]).toEqual([["s001"], []]);
    expect(await repo.read("src/price.ts")).toBe(PRICE);
    expect(await repo.exists("debug.log")).toBe(false);
    expect((await repo.git("status", "--porcelain")).trim()).toBe("M src/tax.ts");
    expect(((await api("/state")).data as { scratch: number }).scratch).toBe(0);
    expect(error(await mt("scratch", "drop")).message).toBe(
      "name what to drop: --id <id> (repeatable), or --all",
    );
  }, 60_000);

  test("a record whose lines changed since is remembered: kept, listed as changed, counted, still stops a commit, until the person forgets it", async () => {
    const id = await scratchEdit({ "src/price.ts": `${PRICE}console.log("price called");\n` }, "trace");
    // The line before the debug line was rewritten since: the patch cannot be taken out as recorded.
    const rewritten = `export const price = (n: number) => Math.round(n);\nconsole.log("price called");\n`;
    await repo.write("src/price.ts", rewritten);
    const why = `src/price.ts changed since it was recorded: its debug lines can no longer be taken out as they were. Take them out by hand, or forget the record (\`metator scratch forget --id ${id}\`)`;
    const r = (await api("/scratch/drop", { method: "POST", body: JSON.stringify({ by: "ana" }) })).data;
    expect(r).toEqual({ dropped: [], failed: [{ id, files: ["src/price.ts"], why }], gone: [] });
    expect(await repo.read("src/price.ts")).toBe(rewritten);
    // Looked at twice: it stays, with its state and why; the count stays; the record file stays.
    for (const _ of [1, 2]) {
      const listed = (await api("/scratch")).data as { items: Data[]; gone?: unknown };
      expect(listed.items).toMatchObject([
        { id, files: ["src/price.ts"], note: "trace", state: "changed", why },
      ]);
      expect(listed.gone).toBeUndefined();
    }
    expect(((await api("/state")).data as { scratch: number }).scratch).toBe(1);
    expect(await repo.exists(`.metator/scratch/${id}.json`)).toBe(true);
    // A commit that would take the file is still stopped.
    const commit = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Bash", tool_input: { command: "git commit -am 'Round prices'" }, session_id: "s9" },
      repo.root,
      { METATOR_PANE_ID: "w1:p9" },
    );
    expect(decision(commit)?.permissionDecisionReason).toContain(
      "this commit holds debug changes: src/price.ts.",
    );
    // The person dealt with it by hand and dismisses the record: nothing is touched.
    const nobody = await mt("scratch", "forget");
    expect(error(nobody).message).toBe("name the records to forget: --id <id> (repeatable)");
    const forgotten = await api("/scratch/forget", {
      method: "POST",
      body: JSON.stringify({ ids: [id], by: "ana" }),
    });
    expect(forgotten.data).toEqual({ forgotten: [{ id, files: ["src/price.ts"] }] });
    expect(await repo.read("src/price.ts")).toBe(rewritten);
    expect(((await api("/state")).data as { scratch: number }).scratch).toBe(0);
    await repo.git("checkout", "--", "src/price.ts");
  }, 60_000);

  test("a record leaves by itself only when no file holds its lines any more, and the look that removes it says so", async () => {
    const id = await scratchEdit({ "src/price.ts": `${PRICE}console.log("price called");\n` }, "trace");
    // The person took the debug line out by hand, and changed the file too.
    await repo.write("src/price.ts", `${PRICE}export const round = Math.round;\n`);
    expect(((await api("/state")).data as { scratch: number }).scratch).toBe(1);
    const listed = data(await mt("scratch", "list")) as { items: unknown[]; gone: Data[] };
    expect(listed).toEqual({
      items: [],
      gone: [{ id, files: ["src/price.ts"], why: `${id} is gone: src/price.ts no longer holds it` }],
    });
    // Said once; then there is nothing to say.
    expect((await api("/scratch")).data).toEqual({ items: [] });
    expect(((await api("/state")).data as { scratch: number }).scratch).toBe(0);
    await repo.git("checkout", "--", "src/price.ts");
  }, 60_000);
});
