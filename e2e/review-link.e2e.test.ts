/**
 * Someone else's MR from its link, end to end (ADR-0097), against FAKE code hosts only: a stand-in
 * MCP server process and a stand-in `gh` on PATH (METATOR_NO_REAL_HOSTS is set). Never github.com.
 * The real `metator` process on real repositories: the refusal when no tool is set up, a review
 * from the diff only with its note, publishing inline only after the gate's Yes, the watcher's
 * card for a new commit and a reply, the re-review with finding states decided by the agent's
 * command, approving through the port only after the person's word, the requested-review card,
 * my MR's new review as a card (no run starts by itself) and sending only the chosen replies.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, metator as cli, E2E_STATE_DIR, hook } from "./helpers/cli.ts";
import { writeGhShim } from "./helpers/fake-gh.ts";
import { ScratchRepo } from "./helpers/repo.ts";

type Data = Record<string, unknown>;
const data = (r: { json: Record<string, unknown> }) => r.json.data as Data;
const SELF = join(import.meta.dir, "..");
const FAKE = join(import.meta.dir, "helpers/fake-mcp-server.ts");
const URL45 = "https://github.com/acme/shop/pull/45";
const ID = "github-acme-shop-45";
const NOTE =
  "Reviewed from the diff only: no local checkout, so the repository's rules, contracts and tests were not used.";
const DIFF = [
  "diff --git a/src/cap.ts b/src/cap.ts",
  "--- a/src/cap.ts",
  "+++ b/src/cap.ts",
  "@@ -1,2 +1,3 @@",
  " export const cap = 1;",
  "+export const max = 100;",
  " export const min = 0;",
  "",
].join("\n");

const pull = (number: number, title: string, author: string, sha: string) => ({
  number,
  title,
  html_url: `https://github.com/acme/shop/pull/${number}`,
  user: { login: author },
  head: { ref: `feat/${number}`, sha },
  base: { ref: "main" },
  state: "open",
});
const theirThread = (id: string, commentId: number, body: string) => ({
  id,
  isResolved: false,
  comments: [{ id: commentId, body, path: "src/cap.ts", line: 2, author: { login: "anna" } }],
});
const HOST = {
  pulls: [
    pull(45, "Cap the discount", "ola", "h1"),
    pull(46, "Rename the tax", "ann", "h46"),
    pull(47, "My own change", "maciej", "h47"),
  ],
  requested: [46],
  diffs: { "45": DIFF, "46": DIFF, "47": DIFF },
  threads: {
    "47": [theirThread("T7", 701, "Why a cap?"), theirThread("T8", 801, "Name the unit.")],
  },
};

let repo: ScratchRepo;
const metator = (args: readonly string[], env: Record<string, string> = {}) => cli(args, repo.root, env);
const runDir = (run: string) => `.metator/runs/${run}`;
const log = async () =>
  (await Bun.file(repo.path("mcp.log")).exists())
    ? (await repo.read("mcp.log"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Data)
    : [];
const finding = (id: string, lens: string, severity: string, claim: string, extra: object = {}) => ({
  id,
  lens,
  severity,
  confidence: 0.9,
  location: { file: "src/cap.ts", line: 2 },
  quote: "export const max = 100;",
  claim,
  ...extra,
});
const findingSet = (lens: string, findings: object[]) =>
  JSON.stringify({ kind: "FindingSet", schemaVersion: 1, lens, shard: "root", findings });

beforeAll(async () => {
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\npulls.json\nmcp.log\n");
  await repo.write(
    ".github/metator/workflows/mt-pr-review.yml",
    await Bun.file(join(SELF, ".github/metator/workflows/mt-pr-review.yml")).text(),
  );
  await repo.write(
    ".github/metator/workflows/mt-review-response.yml",
    "kind: Workflow\nschemaVersion: 2\nid: mt-review-response\nstages:\n  - id: triage\n    owner: mt-review-responder\n",
  );
  // A v14 config: its review source moves to codehost.sources when it is read (MetatorConfig v15).
  await repo.write(
    "metator.config.yml",
    `kind: MetatorConfig
schemaVersion: 14
mcp:
  github:
    command: bun
    args: ["${FAKE}"]
    env:
      FAKE_MCP_PULLS: "${repo.path("pulls.json")}"
      FAKE_MCP_LOG: "${repo.path("mcp.log")}"
reviews:
  sources:
    - { kind: github, repo: acme/shop, author: maciej }
`,
  );
  await repo.write("README.md", "# shop\n");
  await repo.commit("init");
  await repo.write("pulls.json", JSON.stringify(HOST));
});
afterAll(async () => repo.dispose());

describe("no code-host tool for the MR's host", () => {
  test("the refusal sentence the chat says; nothing is written and no run starts", async () => {
    const bare = await ScratchRepo.create();
    try {
      await bare.write(".gitignore", ".metator/\n");
      await bare.write("README.md", "x\n");
      await bare.commit("init");
      // No MCP server, and no gh: the one named does not exist.
      const r = await cli(["review", "open", URL45, "--no-session", "--by", "ann"], bare.root, {
        METATOR_GH_BIN: join(bare.root, "no-gh"),
      });
      expect(r.code).not.toBe(0);
      expect(r.json.error).toMatchObject({
        code: "USAGE",
        message: "I cannot open this MR: no code-host tool for github.com is set up (an MCP server or gh)",
      });
      expect(await Bun.file(bare.path(".metator/reviews")).exists()).toBe(false);
      expect((await cli(["run", "list"], bare.root)).json.data).toEqual([]);
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});

describe("someone else's MR through the MCP stand-in", () => {
  let run = "";

  test("a link without a local repository: a review from the diff only, its stages read the host's diff", async () => {
    const opened = await metator(["review", "open", URL45, "--no-session", "--by", "ann"]);
    expect(opened.code).toBe(0);
    const o = data(opened);
    expect(o.mode).toBe("diff");
    run = o.runId as string;
    expect(o.review).toMatchObject({
      id: ID,
      codehost: "github",
      author: "ola",
      headSha: "h1",
      mode: "diff",
    });
    expect(await repo.read(`${runDir(run)}/change.diff`)).toBe(DIFF);
    const status = data(await metator(["run", "status", "--run", run]));
    expect(JSON.stringify(status)).toContain(NOTE);
    // The stages, as the workflow runs them (source=diff, review=<id>): no git, the diff's files.
    const meta = await metator([
      "review",
      "metadata",
      "--source",
      "diff",
      "--review",
      ID,
      "--out",
      `${runDir(run)}/pr.json`,
    ]);
    expect(data(meta)).toMatchObject({ base: "main", head: "h1", files: ["src/cap.ts"] });
    const plan = data(
      await metator([
        "review",
        "plan",
        "--source",
        "diff",
        "--review",
        ID,
        "--out",
        `${runDir(run)}/review-plan.json`,
      ]),
    );
    expect(plan).toMatchObject({ lenses: ["logic", "security", "tests"], tasks: 3 });
    // The lenses' findings quote the diff: src/cap.ts is not in this repository.
    const dir = `${runDir(run)}/findings`;
    await repo.write(
      `${dir}/logic-root.json`,
      findingSet("logic", [
        finding("LOGIC-001", "logic", "blocking", "max has no unit and any caller reads it as cents", {
          trigger: "any discount",
          reachability: "checkout reads max",
          evidence: { type: "trace", ref: "src/cap.ts:2" },
          verification: { status: "confirmed", by: "mt-verifier", evidence: "traced in the diff" },
        }),
      ]),
    );
    await repo.write(
      `${dir}/tests-root.json`,
      findingSet("tests", [finding("TESTS-001", "tests", "minor", "no test covers max")]),
    );
    await repo.write(`${dir}/security-root.json`, findingSet("security", []));
    const valid = await metator([
      "findings",
      "validate",
      dir,
      "--fix",
      "--plan",
      `${runDir(run)}/review-plan.json`,
      "--diff",
      `${runDir(run)}/change.diff`,
    ]);
    expect(valid.code).toBe(0);
    expect((await metator(["findings", "merge", dir, "--diff", `${runDir(run)}/change.diff`])).code).toBe(0);
    expect(data(await metator(["findings", "verdict", dir])).decision).toBe("CHANGES_REQUIRED");
    for (let i = 0; i < 6; i++)
      expect((await metator(["run", "advance", "pass", "--run", run])).code).toBe(0);
    const asked = data(await metator(["run", "questions", "--run", run])).questions as Data[];
    expect(asked.map((q) => [q.stage, q.prompt])).toEqual([
      ["approval", "Publish the review of MR #45? (1 inline comment, 1 general)"],
    ]);
  }, 120_000);

  test("publish: refused before the gate's Yes; after it one post, inline, the diff-only note first", async () => {
    const early = await metator(["review", "publish", `${runDir(run)}/verdict.json`, "--review", ID]);
    expect((early.json.error as Data).code).toBe("TRANSITION_DENIED");
    expect(await log()).toEqual([]);
    expect((await metator(["run", "approve", "approval", "--run", run, "--by", "ann"])).code).toBe(0);
    const posted = data(await metator(["review", "publish", `${runDir(run)}/verdict.json`, "--review", ID]));
    expect(posted).toMatchObject({ published: true, inline: 1, general: 1 });
    const sent = await log();
    expect(sent[0]).toMatchObject({ inline: 45, path: "src/cap.ts", line: 2 });
    expect(String(sent[0]?.body)).toContain("max has no unit");
    expect(sent[1]).toMatchObject({ review: 45, event: "COMMENT", comments: 1 });
    expect(String(sent[1]?.body).startsWith(NOTE)).toBe(true);
    expect((await metator(["run", "advance", "pass", "--run", run])).code).toBe(0);
    const shown = data(await metator(["review", "show", ID]));
    expect(shown).toMatchObject({ reviewedSha: "h1", status: "published", counts: { open: 2 } });
    expect((shown.comments as Data[])[0]).toMatchObject({ findingId: "f1", file: "src/cap.ts", line: 2 });
    expect(String((shown.comments as Data[])[0]?.threadId)).toMatch(/^RT/);
  }, 60_000);

  test("the watcher: the requests asking me become a card; a new commit and the author's reply become one", async () => {
    const first = data(await metator(["review", "check"]));
    expect(first).toMatchObject({ news: [], requested: ["github-acme-shop-46"] });
    const state = JSON.parse(await repo.read("pulls.json")) as typeof HOST & {
      threads: Record<string, { id: string; comments: object[] }[]>;
    };
    const ours = (state.threads["45"] ?? [])[0] as { comments: object[] };
    ours.comments.push({ id: 9001, body: "It is in cents now.", author: { login: "ola" } });
    state.pulls[0] = { ...pull(45, "Cap the discount", "ola", "h2") };
    state.diffs["45"] = DIFF.replace("max = 100", "maxCents = 100");
    await repo.write("pulls.json", JSON.stringify(state));
    expect(data(await metator(["review", "check"])).news).toEqual([ID]);
    const listed = data(await metator(["review", "list"]));
    expect((listed.cards as Data[]).map((c) => [c.kind, c.prompt])).toEqual([
      ["changed", "MR #45: 1 new commit, 1 reply"],
      ["requested", "You were asked to review MR #46: Rename the tax"],
    ]);
    const shown = data(await metator(["review", "show", ID]));
    expect((shown.findings as Data[]).map((f) => [f.state, f.candidates])).toEqual([
      ["open", ["changed", "replied"]],
      ["open", ["changed"]],
    ]);
  }, 60_000);

  test("re-review: a run over the new commits; the agent decides each finding with a reason; all fixed proposes approval", async () => {
    const again = data(await metator(["review", "rereview", ID, "--no-session", "--by", "ann"]));
    const second = again.runId as string;
    expect(await repo.read(`${runDir(second)}/delta.diff`)).toContain("+export const maxCents = 100;");
    const task = JSON.stringify(data(await metator(["run", "status", "--run", second])));
    expect(task).toContain("Re-review MR #45");
    expect(task).toContain(`metator review finding ${ID}`);
    // The tool never decides: a state without a reason is refused.
    expect((await metator(["review", "finding", ID, "--finding", "f1", "--state", "fixed"])).code).not.toBe(
      0,
    );
    for (const [f, why] of [
      ["f1", "the constant says cents now"],
      ["f2", "maxCents is covered by cap.test.ts"],
    ] as const)
      expect(
        (await metator(["review", "finding", ID, "--finding", f, "--state", "fixed", "--reason", why])).code,
      ).toBe(0);
    // The re-review's run goes on: no card yet. It ends (nothing new to publish): the proposal.
    expect((data(await metator(["review", "list"])).cards as Data[]).filter((c) => c.review === ID)).toEqual(
      [],
    );
    for (let i = 0; i < 6; i++) await metator(["run", "advance", "pass", "--run", second]);
    await metator(["run", "approve", "approval", "--run", second, "--by", "ann"]);
    await metator(["run", "advance", "pass", "--run", second]);
    const cards = data(await metator(["review", "list"])).cards as Data[];
    expect(cards.find((c) => c.review === ID)).toMatchObject({
      kind: "approve",
      prompt: "All 2 findings are fixed: approve MR #45?",
    });
  }, 120_000);

  test("approve: the guard asks the person; without a name nothing reaches the host; with it, through the port", async () => {
    const asked = await hook(
      ["guard", "pre-tool"],
      { tool_name: "Bash", tool_input: { command: `metator review approve ${ID} --by ann` } },
      repo.root,
    );
    expect((asked.json?.hookSpecificOutput as Data | undefined)?.permissionDecision).toBe("ask");
    expect((await metator(["review", "approve", ID])).code).not.toBe(0);
    expect((await log()).filter((e) => "approve" in e)).toEqual([]);
    const approved = data(await metator(["review", "approve", ID, "--by", "ann"]));
    expect(approved).toMatchObject({
      status: "approved",
      watch: { active: false, ended: { why: "approved" } },
    });
    expect((await log()).filter((e) => "approve" in e)).toEqual([{ approve: 45 }]);
  }, 60_000);
});

describe("my MR (reviews.sources moved to codehost.sources)", () => {
  test("a new review is kept and carded; no run starts by itself; send only the chosen replies", async () => {
    const scan = data(await metator(["mrs", "scan"]));
    expect(scan.requests).toEqual([{ id: "github-acme-shop-47", number: 47, open: 2, fresh: ["T7", "T8"] }]);
    const listed = data(await metator(["mrs", "list"]));
    expect(listed.cards).toEqual([
      {
        id: "mine:github-acme-shop-47",
        kind: "mine",
        review: "github-acme-shop-47",
        number: 47,
        title: "My own change",
        url: "https://github.com/acme/shop/pull/47",
        prompt: "New review in MR #47 (2 threads)",
        actions: [{ label: "Analyse", method: "POST", path: "/mrs/github-acme-shop-47/analyse" }],
      },
    ]);
    const runs = (await metator(["run", "list"])).json.data as Data[];
    expect(runs.filter((r) => String(r.runId).includes("mt-review-response"))).toEqual([]);
    for (const [t, reply] of [
      ["T7", "A cap keeps refunds bounded."],
      ["T8", "Cents."],
    ] as const)
      await metator([
        "mrs",
        "triage",
        "github-acme-shop-47",
        "--thread",
        t,
        "--kind",
        "question",
        "--reply",
        reply,
      ]);
    const sent = data(
      await metator(["mrs", "send", "github-acme-shop-47", "--by", "maciej", "--only", "T7"]),
    );
    expect(sent).toEqual({ sent: ["T7"], skipped: ["T8"] });
    expect((await log()).filter((e) => "reply" in e)).toEqual([
      { reply: 701, pull: 47, body: "A cap keeps refunds bounded." },
    ]);
    expect(
      (await metator(["mrs", "send", "github-acme-shop-47", "--by", "maciej", "--skip", "T9"])).code,
    ).not.toBe(0);
  }, 60_000);
});

describe("the daemon's routes (what Home and the Reviews place read)", () => {
  test("GET /reviews and /inbox carry the cards; a card waved away goes; approve is a person's, never a pane's", async () => {
    const d = Bun.spawn(
      [
        "bun",
        CLI_ENTRY,
        "serve",
        "--port",
        "0",
        "--supervise-ms",
        "0",
        "--intake-ms",
        "0",
        "--reviews-ms",
        "0",
      ],
      {
        cwd: repo.root,
        env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    try {
      const reader = d.stderr.getReader();
      let text = "";
      let url = "";
      while (!url) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        const line = text.split("\n").find((l) => l.includes('"serving"'));
        if (line) url = (JSON.parse(line) as { serving: { url: string } }).serving.url;
      }
      const get = async (path: string) =>
        ((await (await fetch(`${url}${path}`)).json()) as { data: Data }).data;
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${url}${path}`, { method: "POST", body: JSON.stringify(body), headers });
      const listed = await get("/reviews");
      expect((listed.reviews as Data[]).find((r) => r.id === ID)).toMatchObject({ status: "approved" });
      expect((listed.cards as Data[]).map((c) => c.id)).toEqual(["requested:github-acme-shop-46"]);
      const inbox = await get("/inbox");
      expect((inbox.reviews as Data[]).map((c) => c.kind)).toEqual(["requested"]);
      expect(((await get("/mrs")).requests as Data[]).map((r) => [r.id, r.fresh])).toEqual([
        ["github-acme-shop-47", 0],
      ]);
      const refused = await post(
        "/reviews/github-acme-shop-46/approve",
        { by: "ann" },
        { "x-metator-pane": "w1:p1" },
      );
      expect(refused.status).toBe(403);
      expect(
        (await post("/reviews/github-acme-shop-46/dismiss", { card: "requested", by: "ann" })).status,
      ).toBe(200);
      expect((await get("/reviews")).cards).toEqual([]);
      const sent = await post("/mrs/github-acme-shop-47/send", { by: "maciej", skip: ["T8"] });
      expect(((await sent.json()) as { data: Data }).data).toEqual({ sent: [], skipped: ["T8"] });
    } finally {
      d.kill("SIGTERM");
      await d.exited;
    }
  }, 60_000);
});

describe("GitHub through the gh stand-in on PATH", () => {
  test("a configured gh source reads the MR and approves it through gh, never through MCP", async () => {
    const other = await ScratchRepo.create();
    const bin = mkdtempSync(join(tmpdir(), "metator-gh-bin-"));
    try {
      writeGhShim(bin);
      await other.write(".gitignore", ".metator/\ngh.json\ngh.log\n");
      await other.write(
        ".github/metator/workflows/mt-pr-review.yml",
        await Bun.file(join(SELF, ".github/metator/workflows/mt-pr-review.yml")).text(),
      );
      await other.write(
        "metator.config.yml",
        "kind: MetatorConfig\nschemaVersion: 15\ncodehost:\n  sources:\n    - { id: shop, kind: github, repo: acme/shop, via: gh }\n",
      );
      await other.write("README.md", "x\n");
      await other.commit("init");
      await other.write(
        "gh.json",
        JSON.stringify({ ...HOST, pulls: [pull(45, "Cap, as gh sees it", "ola", "g1")], threads: {} }),
      );
      const env = {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FAKE_GH_STATE: other.path("gh.json"),
        FAKE_GH_LOG: other.path("gh.log"),
      };
      const opened = data(
        await cli(["review", "open", URL45, "--no-session", "--by", "ann"], other.root, env),
      );
      expect(opened.review).toMatchObject({ title: "Cap, as gh sees it", headSha: "g1", mode: "diff" });
      expect((await cli(["review", "approve", ID, "--by", "ann"], other.root, env)).code).toBe(0);
      expect(JSON.parse((await other.read("gh.log")).trim())).toEqual({ gh: true, approve: 45 });
    } finally {
      await other.dispose();
    }
  }, 60_000);
});

describe("watching by hand", () => {
  test("unwatch stops the watcher's reads; watch takes it up again; a card waved away stays away", async () => {
    const id = "github-acme-shop-46";
    expect(data(await metator(["review", "unwatch", id, "--by", "ann"]))).toMatchObject({
      status: "unwatched",
    });
    expect(data(await metator(["review", "check"])).checked).not.toContain(id);
    expect(data(await metator(["review", "watch", id, "--by", "ann"]))).toMatchObject({
      watch: { active: true },
    });
    expect(data(await metator(["review", "check"])).checked).toContain(id);
    // Waved away in the app already: the CLI says the same, once more.
    expect((await metator(["review", "dismiss", id, "--card", "requested", "--by", "ann"])).code).toBe(0);
    expect((data(await metator(["review", "list"])).cards as Data[]).map((c) => c.id)).toEqual([]);
    // Analyse opens a pane a person sees: only the daemon can.
    const analyse = await metator(["mrs", "analyse", "github-acme-shop-47", "--by", "maciej"]);
    expect(String((analyse.json.error as Data).message)).toContain("needs the daemon");
  }, 60_000);
});
