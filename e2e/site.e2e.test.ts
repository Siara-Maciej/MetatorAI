/**
 * The user documentation site end to end: the CLI reference matches the CLI, every shipped agent
 * and document kind is documented, and the built site renders in a real Chromium without errors.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browser, closeBrowser } from "./helpers/browser.ts";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => Bun.file(join(ROOT, path)).text();

let out: string;
let server: ReturnType<typeof Bun.serve>;

/** Serves the built site like GitHub Pages: `/guide/x` → `guide/x.html`, `/` → `index.html`. */
function serve(dir: string) {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      for (const candidate of [path, `${path}.html`, join(path, "index.html")]) {
        const file = join(dir, candidate);
        if (file.startsWith(dir) && existsSync(file) && !file.endsWith("/")) {
          const f = Bun.file(file);
          if (f.size > 0 || candidate.endsWith(".html")) return new Response(f);
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
}

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "metator-site-"));
  const build = Bun.spawn(["bunx", "vitepress", "build", "site", "--outDir", out], {
    cwd: ROOT,
    env: { ...process.env, SITE_BASE: "/" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (code !== 0) throw new Error(`vitepress build failed:\n${stdout}\n${stderr}`);
  server = serve(out);
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  await closeBrowser();
  await rm(out, { recursive: true, force: true });
});

describe("documentation site", () => {
  test("the CLI reference is generated from the CLI and up to date", async () => {
    const check = Bun.spawn(["bun", "scripts/site/cli-reference.ts", "--check"], {
      cwd: ROOT,
      stderr: "pipe",
    });
    expect(await check.exited).toBe(0);
    const reference = await read("site/reference/cli.md");
    for (const command of ["metator run approve", "metator system lint", "metator findings to-github"])
      expect(reference).toContain(`### \`${command}\``);
  });

  test("every shipped agent and every document kind is documented", async () => {
    const agents = await read("site/how-to/agents.md");
    for await (const file of new Bun.Glob("metator/agents/*.md").scan({ cwd: ROOT }))
      expect(agents).toContain(`\`${file.slice("metator/agents/".length, -3)}\``);
    const documents = await read("site/reference/documents.md");
    for await (const file of new Bun.Glob("docs/metator/schemas/*.v*.json").scan({ cwd: ROOT })) {
      if (file.endsWith(".example.json")) continue;
      const kind = file.slice("docs/metator/schemas/".length).split(".")[0] as string;
      expect(documents).toContain(`\`${kind}\``);
    }
  });

  test("the built site renders every section in a real browser without errors", async () => {
    const page = await (await browser()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const base = `http://localhost:${server.port}`;
    await page.goto(`${base}/`);
    expect(await page.locator(".VPHero .name").textContent()).toBe("MetatorAI");
    for (const [path, title] of [
      ["/guide/quick-start", "Quick start"],
      ["/workflows/feature", "Feature (W1 mt-feature)"],
      ["/how-to/rules", "Write and enforce rules"],
      ["/reference/cli", "CLI reference"],
    ]) {
      const response = await page.goto(`${base}${path}`);
      expect(response?.status()).toBe(200);
      // VitePress adds a heading anchor with a zero-width space.
      const heading = (await page.locator("main h1").first().textContent()) ?? "";
      expect(heading.replace(/[\s​]+/g, " ").trim()).toBe(title as string);
    }
    // The sidebar links the whole how-to section.
    await page.goto(`${base}/how-to/rules`);
    expect(await page.locator(".VPSidebar a").count()).toBeGreaterThanOrEqual(6);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
