/**
 * Others' MRs in the app end to end (round 18, ADR-0097): the built app in a real Chromium over the
 * real daemon, which reads the code host through a real MCP server process (a stand-in for GitHub;
 * never a real code host) and drives agents with the scenario host only. Home shows "You were asked
 * to review MR #46", whose Review opens the reviewer's terminal; the review asks to publish on one
 * Yes/No card; a new commit and an author's reply bring "MR #46: 1 new commit, 1 reply", whose
 * Re-review opens a terminal again; the Reviews place shows each finding's state with its reason;
 * once all are fixed, "approve MR #46?" approves at the host only after Yes.
 *
 * The repository's own `mt-pr-review` is a short one here (judge → approval → publish): the
 * review's lenses are the engine's business, the cards and the place are this test's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { browser, closeBrowser } from "./helpers/browser.ts";
import { CLI_ENTRY, E2E_STATE_DIR, metator, stopProcessesUnder } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

const ROOT = join(import.meta.dir, "..");
const FAKE = join(import.meta.dir, "helpers/fake-mcp-server.ts");
const SHOTS = process.env.METATOR_SHOTS;
const URL46 = "https://github.com/acme/shop/pull/46";
const ID = "github-acme-shop-46";
const DIFF = `diff --git a/src/tax.ts b/src/tax.ts
new file mode 100644
--- /dev/null
+++ b/src/tax.ts
@@ -0,0 +1,2 @@
+export const rate = 0.23;
+export const tax = (n: number) => n * rate;
`;
const VERDICT = JSON.stringify({
  kind: "Verdict",
  schemaVersion: 1,
  decision: "CHANGES_REQUIRED",
  blocking: [
    {
      id: "LOGIC-001",
      lens: "logic",
      severity: "blocking",
      confidence: 0.9,
      location: { file: "src/tax.ts", line: 2 },
      quote: "n * rate",
      claim: "The tax is not rounded to whole cents.",
      verification: { status: "confirmed", by: "mt-verifier", evidence: "tax(0.1) is 0.023" },
    },
  ],
  unverified: [],
  consider: [
    {
      id: "TESTS-001",
      lens: "tests",
      severity: "minor",
      confidence: 0.7,
      location: { file: "src/tax.ts", line: 1 },
      quote: "rate",
      claim: "No test covers the tax rate.",
    },
  ],
  verifiedCorrect: [],
});
// The short review: the judge writes the verdict, the person approves publishing, the script posts.
const REVIEW = `kind: Workflow
schemaVersion: 3
id: mt-pr-review
input:
  oneOf: [pr, base]
  optional: [lenses, source, review, since]
stages:
  - id: judge
    owner: mt-judge
    produces: [verdict.json]
  - id: approval
    description: Publish the review
    hitl: true
    skipAt: [L1, L2]
    grants: [comment]
  - id: publish
    owner: "script:metator review publish {runDir}/verdict.json --review {review}"
`;
// The conductor says what it is and waits; the judge writes the verdict. No real AI host starts.
const CONDUCTOR = `    - - say: "I am the reviewer. I read the MR from its diff."
      - run: 'sleep 300'
`;
const SCENARIO = `kind: AgentScenario
schemaVersion: 2
agents:
  mt-orchestrator:
${CONDUCTOR}${CONDUCTOR}${CONDUCTOR}
  mt-judge:
    - - write: { path: "{runDir}/verdict.json", text: ${JSON.stringify(VERDICT)} }
      - say: "STATUS: done"
`;

let repo: ScratchRepo;
let daemon: Bun.Subprocess<"ignore", "ignore", "pipe">;
let base = "";
let dist: string;
let configDir: string;
let bin: string;
let env: Record<string, string>;
let site: ReturnType<typeof Bun.serve>;
let page: Page;
const errors: string[] = [];

type Pulls = {
  pulls: { number: number; title: string; head: { ref: string; sha: string }; base: { ref: string } }[];
  threads: Record<string, { id: string; isResolved?: boolean; comments: Record<string, unknown>[] }[]>;
  diffs: Record<string, string>;
  requested: number[];
};
type Review = {
  id: string;
  status: string;
  runs: string[];
  findings: { id: string; state: string }[];
  comments: { threadId?: string }[];
};

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 40_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}
const mt = (args: string[]) => metator(args, repo.root, env);
const app = (hash: string) => `http://127.0.0.1:${site.port}/?daemon=${encodeURIComponent(base)}#/${hash}`;
const review = async (): Promise<Review | undefined> => {
  const r = (await (await fetch(`${base}/reviews`)).json()) as { data?: { reviews: Review[] } };
  return r.data?.reviews.find((x) => x.id === ID);
};
const shot = async (name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name) });
};
const text = async (testId: string) =>
  (await page
    .getByTestId(testId)
    .first()
    .textContent({ timeout: 1000 })
    .catch(() => "")) ?? "";
const says = (testId: string, words: string) =>
  until(`${testId} to say "${words}"`, async () => ((await text(testId)).includes(words) ? true : undefined));
const log = async () =>
  existsSync(repo.path("mcp.log"))
    ? (await Bun.file(repo.path("mcp.log")).text())
        .trim()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
/** The card (by its test id) on Home while Home says `words`: steps through the queue with Next. */
async function cardOnHome(testId: string, words: string) {
  await page.goto(app("inbox"));
  return until(`the card "${words}" on Home`, async () => {
    const card = page.getByTestId(testId);
    const home =
      (await page
        .locator(".home")
        .textContent({ timeout: 1000 })
        .catch(() => "")) ?? "";
    if ((await card.count()) > 0 && home.includes(words)) return card;
    const next = page.getByRole("button", { name: "Next ›" });
    if ((await next.count()) > 0 && (await next.isEnabled())) await next.click();
    return undefined;
  });
}
async function nameIfAsked() {
  const who = page.getByRole("dialog", { name: "your name" });
  if (
    await who.waitFor({ timeout: 1500 }).then(
      () => true,
      () => false,
    )
  ) {
    await who.getByLabel("Your name").fill("ana");
    await who.getByRole("button", { name: "Save" }).click();
  }
}

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "metator-desktop-reviews-"));
  const build = Bun.spawn(["bunx", "vite", "build", "--outDir", dist], {
    cwd: join(ROOT, "packages/desktop"),
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
  site = Bun.serve({
    port: 0,
    fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const file = join(dist, path === "/" ? "index.html" : path);
      return file.startsWith(dist) && existsSync(file)
        ? new Response(Bun.file(file))
        : new Response(Bun.file(join(dist, "index.html")));
    },
  });
  configDir = await mkdtemp(join(tmpdir(), "metator-desktop-reviews-config-"));
  bin = await mkdtemp(join(tmpdir(), "metator-bin-"));
  await Bun.write(join(bin, "metator"), `#!/bin/sh\nexec bun ${CLI_ENTRY} "$@"\n`);
  chmodSync(join(bin, "metator"), 0o755);
  repo = await ScratchRepo.create();
  await repo.write(".gitignore", ".metator/\npulls.json\nmcp.log\nscenario.yml\n");
  await repo.write("scenario.yml", SCENARIO);
  await repo.write(".github/metator/workflows/mt-pr-review.yml", REVIEW);
  await repo.write("src/discount.ts", "export const discount = 0.1;\n");
  await repo.write(
    "metator.config.yml",
    `kind: MetatorConfig
schemaVersion: 15
hosts:
  metatorCommand: ${join(bin, "metator")}
supervisor:
  hostOrder: [scenario]
mcp:
  github:
    command: bun
    args: ["${FAKE}"]
    env:
      FAKE_MCP_PULLS: "${repo.path("pulls.json")}"
      FAKE_MCP_LOG: "${repo.path("mcp.log")}"
codehost:
  sources:
    - { id: shop, kind: github, repo: acme/shop, via: "mcp:github", author: ana }
  review: { autoPublish: false, watch: true, everyMs: 1000 }
reviews:
  everyMs: 1000
`,
  );
  await repo.commit("init");
  // Anna's MR, where Ana (the person) is a requested reviewer; no MR of Ana's own.
  const pulls: Pulls = {
    pulls: [
      {
        number: 46,
        title: "Add the tax",
        head: { ref: "feat/tax", sha: "a46a46a" },
        base: { ref: "main" },
        ...{ html_url: URL46, user: { login: "anna" }, state: "open" },
      },
    ],
    threads: {},
    diffs: { "46": DIFF },
    requested: [46],
  };
  await Bun.write(repo.path("pulls.json"), JSON.stringify(pulls));
  env = {
    METATOR_CONFIG_DIR: configDir,
    METATOR_USER: "ana",
    METATOR_HOST: "scenario",
    METATOR_AGENT_SCENARIO: repo.path("scenario.yml"),
    METATOR_NO_REAL_HOSTS: "1",
    METATOR_GATE_WAIT_MS: "300",
    METATOR_CLAUDE_BIN: "/nonexistent/claude",
    METATOR_COPILOT_BIN: "/nonexistent/copilot",
    METATOR_OPENCODE_BIN: "/nonexistent/opencode",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  daemon = Bun.spawn(
    ["bun", CLI_ENTRY, "serve", "--port", "0", "--poll-ms", "100", "--supervise-ms", "0", "--intake-ms", "0"],
    {
      cwd: repo.root,
      env: { ...process.env, METATOR_STATE_DIR: E2E_STATE_DIR, ...env },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const reader = daemon.stderr.getReader();
  let out = "";
  base = await until("the daemon to listen", async () => {
    const { value, done } = await reader.read();
    if (done) return "";
    out += new TextDecoder().decode(value);
    const line = out.split("\n").find((l) => l.includes('"serving"'));
    return line ? (JSON.parse(line) as { serving: { url: string } }).serving.url : undefined;
  });
  void (async () => {
    for (;;) if ((await reader.read().catch(() => ({ done: true }))).done) return;
  })();
  page = await (await browser()).newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
}, 180_000);

afterAll(async () => {
  await page?.close();
  await closeBrowser();
  daemon?.kill("SIGTERM");
  await daemon?.exited;
  // The conductors' panes and any drive work in the repository: nothing outlives it.
  if (repo) stopProcessesUnder(repo.root);
  site?.stop(true);
  await repo?.dispose();
  await rm(dist, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});

describe("MetatorAI Desktop: others' MRs (real daemon, real Chromium, fake code host)", () => {
  let reviewRun = "";

  test("asked to review: a card on Home; Review opens the reviewer's terminal", async () => {
    const card = await cardOnHome("review-card-requested", "You were asked to review MR #46: Add the tax");
    await shot("18-home-requested.png");
    await card.getByRole("button", { name: "Review" }).click();
    await nameIfAsked();
    reviewRun = await until("the review's run", async () => (await review())?.runs[0]);
    await until("the reviewer's terminal", async () =>
      page.url().includes(`#/run/${reviewRun}/terminal`) ? true : undefined,
    );
    expect(errors).toEqual([]);
  }, 120_000);

  test("the review asks to publish on one Yes/No card; Yes posts it all, inline", async () => {
    // The run goes to its approval gate (the judge writes the verdict), as its conductor would drive it.
    expect((await mt(["run", "drive", "--run", reviewRun, "--detach"])).code).toBe(0);
    const card = await cardOnHome(
      "publish-yes-no",
      "Publish the review of MR #46? (1 inline comment, 1 general)",
    );
    expect(await page.locator(".home").textContent()).toContain(
      "Publish the review of MR #46? (1 inline comment, 1 general)",
    );
    // One consent for the whole review: no option to pick, no reason to write.
    expect(await page.locator(".home .options").count()).toBe(0);
    await shot("18-home-publish.png");
    expect((await log()).some((e) => e.inline !== undefined)).toBe(false);
    await card.getByRole("button", { name: "Yes" }).click();
    // The drive goes on with the answer: the publish stage posts through the code host.
    await until("the review published", async () =>
      (await review())?.status === "published" ? true : undefined,
    );
    const posted = await log();
    expect(posted.filter((e) => e.inline === 46)).toEqual([
      expect.objectContaining({ path: "src/tax.ts", line: 2 }) as never,
    ]);
    expect(posted.some((e) => e.review === 46)).toBe(true);
    expect(errors).toEqual([]);
  }, 120_000);

  test("Reviews: a watched MR with one word; its findings with their state badges", async () => {
    await page.goto(app(`reviews/${ID}`));
    await says(`review-${ID}`, "watching");
    expect(await text(`review-${ID}`)).toContain("#46 Add the tax");
    expect(await text(`review-${ID}`)).toContain("2 open");
    expect(await text(`review-${ID}`)).not.toContain("github");
    expect(await text("finding-f1")).toContain("open");
    expect(await text("finding-f1")).toContain("src/tax.ts:2");
    expect(await text("finding-f1")).toContain("The tax is not rounded to whole cents.");
    expect(await text("finding-f2")).toContain("No test covers the tax rate.");
    expect(await page.getByTestId("rereview").isEnabled()).toBe(true);
    expect(await page.getByTestId("unwatch").isEnabled()).toBe(true);
  }, 60_000);

  test("a new commit and the author's reply: a card; Re-review opens the agent's terminal", async () => {
    const pulls = JSON.parse(await Bun.file(repo.path("pulls.json")).text()) as Pulls;
    const pr = pulls.pulls[0];
    if (pr) pr.head.sha = "b46b46b";
    pulls.diffs["46"] = DIFF.replace("n * rate", "Math.round(n * rate * 100) / 100");
    const thread = (pulls.threads["46"] ?? [])[0];
    thread?.comments.push({ id: 9001, body: "Rounded now.", author: { login: "anna" } });
    await Bun.write(repo.path("pulls.json"), JSON.stringify(pulls));
    const card = await cardOnHome("review-card-changed", "MR #46: 1 new commit, 1 reply");
    await shot("18-home-rereview.png");
    await card.getByRole("button", { name: "Re-review" }).click();
    const again = await until("the re-review's run", async () => (await review())?.runs[1]);
    await until("the re-review's terminal", async () =>
      page.url().includes(`#/run/${again}/terminal`) ? true : undefined,
    );
    // The re-review's agent decides each finding's state with its reason (the test plays it), then ends.
    expect(
      (
        await mt([
          "review",
          "finding",
          ID,
          "--finding",
          "f1",
          "--state",
          "fixed",
          "--reason",
          "Rounded to cents in the new commit.",
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await mt([
          "review",
          "finding",
          ID,
          "--finding",
          "f2",
          "--state",
          "not-fixed",
          "--reason",
          "Still no test of the rate.",
        ])
      ).code,
    ).toBe(0);
    expect(
      (await mt(["run", "close", again, "--aborted", "--reason", "the test plays the re-review"])).code,
    ).toBe(0);
    await page.goto(app(`reviews/${ID}`));
    await says("finding-f1", "Rounded to cents in the new commit.");
    expect(await text("finding-f1")).toContain("fixed");
    await says("finding-f2", "not fixed");
    expect(await text("finding-f2")).toContain("Still no test of the rate.");
    await shot("18-reviews-findings.png");
    expect(errors).toEqual([]);
  }, 120_000);

  test("all findings fixed: the approve card; the MR is approved at the host only after Yes", async () => {
    expect(
      (
        await mt([
          "review",
          "finding",
          ID,
          "--finding",
          "f2",
          "--state",
          "fixed",
          "--reason",
          "A test of the rate was added.",
        ])
      ).code,
    ).toBe(0);
    const card = await cardOnHome("review-card-approve", "All 2 findings are fixed: approve MR #46?");
    await shot("18-home-approve.png");
    expect((await log()).some((e) => e.approve !== undefined)).toBe(false);
    await card.getByRole("button", { name: "Yes" }).click();
    await until("the approval at the host", async () =>
      (await log()).some((e) => e.approve === 46) ? true : undefined,
    );
    await until("the MR approved", async () => ((await review())?.status === "approved" ? true : undefined));
    // Watching ended: the row is under "ended" in the place, with its word.
    await page.goto(app("reviews"));
    await page.getByRole("button", { name: /ended · 1/ }).click();
    await says(`review-${ID}`, "approved");
    expect(errors).toEqual([]);
  }, 120_000);
});
