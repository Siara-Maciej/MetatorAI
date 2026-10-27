/**
 * The user documentation site end to end: the CLI reference matches the CLI, every shipped agent
 * and document kind is documented, and the built site renders in a real Chromium without errors.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
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
    const reference = await read("site/api/commands.md");
    for (const command of ["metator run approve", "metator system lint", "metator findings to-github"])
      expect(reference).toContain(`### \`${command}\``);
  });

  test("every shipped agent, skill and document kind is on the site", async () => {
    // The gallery is rendered from metator/agents at build time: every agent must be in the HTML.
    const gallery = await Bun.file(join(out, "agents/index.html")).text();
    for await (const file of new Bun.Glob("metator/agents/*.md").scan({ cwd: ROOT }))
      expect(gallery).toContain(`data-agent="${file.slice("metator/agents/".length, -3)}"`);
    const skills = await read("site/agents/skills.md");
    for await (const file of new Bun.Glob("metator/skills/*/SKILL.md").scan({ cwd: ROOT }))
      expect(skills).toContain(`\`${file.split("/")[2]}\``);
    const documents = await read("site/api/documents.md");
    for await (const file of new Bun.Glob("docs/metator/schemas/*.v*.json").scan({ cwd: ROOT })) {
      if (file.endsWith(".example.json")) continue;
      const kind = file.slice("docs/metator/schemas/".length).split(".")[0] as string;
      expect(documents).toContain(`\`${kind}\``);
    }
  });

  test("workflow diagrams show exactly the stages of the shipped specs", async () => {
    const pages: Record<string, string> = {
      "mt-feature": "workflows/feature.html",
      "mt-bugfix": "workflows/bugfix.html",
      "mt-refactor": "workflows/refactor.html",
      "mt-pr-review": "workflows/review.html",
      "mt-self-review": "workflows/review.html",
    };
    for (const [id, page] of Object.entries(pages)) {
      const spec = parse(await read(`.github/metator/workflows/${id}.yml`)) as { stages: { id: string }[] };
      const html = await Bun.file(join(out, page)).text();
      const section = html.slice(html.indexOf(`aria-label="Workflow ${id}"`));
      const drawn = [
        ...section.slice(0, section.indexOf("</section>")).matchAll(/data-stage="([^"]+)"/g),
      ].map((m) => m[1]);
      expect([id, drawn]).toEqual([id, spec.stages.map((s) => s.id)]);
    }
  });

  test("the built site renders every section in a real browser, animated and without errors", async () => {
    const page = await (await browser()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const base = `http://localhost:${server.port}`;
    await page.goto(`${base}/`);
    expect(await page.locator(".VPHero .name").textContent()).toBe("MetatorAI");
    // The numbers on the landing page come from the canon.
    const agents = [...new Bun.Glob("metator/agents/*.md").scanSync({ cwd: ROOT })].length;
    expect(await page.locator(".mx-stats strong").first().textContent()).toBe(String(agents));
    for (const [path, title] of [
      ["/product/idea", "The idea"],
      ["/product/how-it-works", "How it works"],
      ["/product/enterprise", "Security and governance"],
      ["/guide/quick-start", "Quick start"],
      ["/workflows/feature", "Feature (W1 mt-feature)"],
      ["/agents/", "Agents and delegation"],
      ["/multi-repo/", "Systems of many applications"],
      ["/how-to/rules", "Write and enforce rules"],
      ["/api/", "API overview"],
      ["/api/hooks", "Hooks protocol"],
      ["/api/extending", "Extending: ports and plugins"],
      ["/api/commands", "Command reference"],
    ]) {
      const response = await page.goto(`${base}${path}`);
      expect(response?.status()).toBe(200);
      // VitePress adds a heading anchor with a zero-width space.
      const heading = (await page.locator("main h1").first().textContent()) ?? "";
      expect(heading.replace(/[\s\u200b]+/g, " ").trim()).toBe(title as string);
    }
    // The run token moves: the active stage of the workflow diagram changes over time.
    await page.goto(`${base}/workflows/feature`);
    const active = () => page.locator(".mx-wf-stage.active").getAttribute("data-stage");
    const first = await active();
    await page.waitForTimeout(1700);
    expect(await active()).not.toBe(first);
    // The API overview lists every command group, linked into the reference.
    await page.goto(`${base}/api/`);
    expect(await page.locator(".mx-cmd").count()).toBeGreaterThanOrEqual(30);
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  test("animations never change the page height, so scrolling does not jump (desktop and phone)", async () => {
    const base = `http://localhost:${server.port}`;
    const pages = ["/", "/multi-repo/", "/workflows/feature", "/agents/"];
    // One full terminal cycle (~20 s), every page and width at once.
    const sample = async (width: number, path: string) => {
      const page = await (await browser()).newPage({ viewport: { width, height: 900 } });
      await page.goto(`${base}${path}`);
      const heights = new Set<number>();
      for (let i = 0; i < 44; i++) {
        heights.add(await page.evaluate(() => document.documentElement.scrollHeight));
        await page.waitForTimeout(500);
      }
      await page.close();
      return [width, path, heights.size];
    };
    const runs = await Promise.all([1280, 390].flatMap((w) => pages.map((p) => sample(w, p))));
    expect(runs).toEqual([1280, 390].flatMap((w) => pages.map((p) => [w, p, 1])));
  }, 90_000);

  test("every package-manager code group offers npm, pnpm, yarn and bun, in that order", async () => {
    const groups: string[][] = [];
    for (const file of new Bun.Glob("**/*.html").scanSync({ cwd: out })) {
      const html = await Bun.file(join(out, file)).text();
      for (const g of html.split('class="vp-code-group').slice(1)) {
        const tabs = g.slice(0, g.indexOf('class="blocks"'));
        const labels = [...tabs.matchAll(/<label[^>]*>([^<]+)<\/label>/g)].map((m) =>
          (m[1] as string).trim(),
        );
        if (labels.some((l) => ["npm", "pnpm", "yarn", "bun"].includes(l))) groups.push(labels);
      }
    }
    expect(groups.length).toBeGreaterThanOrEqual(6);
    for (const labels of groups) expect(labels).toEqual(["npm", "pnpm", "yarn", "bun"]);
  });

  test("one package-manager switch changes every command on every page, without scrolling", async () => {
    const base = `http://localhost:${server.port}`;
    const page = await (await browser()).newPage({ viewport: { width: 1280, height: 900 } });
    const shown = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".vp-code-group")]
          .map((g) => {
            const input = [...g.querySelectorAll(":scope > .tabs > input")].find(
              (i) => (i as HTMLInputElement).checked,
            );
            const label = input && g.querySelector(`label[for="${input.id}"]`)?.textContent?.trim();
            const active = [...(g.querySelector(":scope > .blocks")?.children ?? [])].findIndex((b) =>
              b.classList.contains("active"),
            );
            const labels = [...g.querySelectorAll(":scope > .tabs > label")].map((l) =>
              l.textContent?.trim(),
            );
            return { label, matches: labels[active] === label };
          })
          .filter((g) => ["npm", "pnpm", "yarn", "bun"].includes(g.label as string)),
      );
    await page.goto(`${base}/guide/installation`);
    expect((await shown()).every((g) => g.label === "npm" && g.matches)).toBe(true);
    // A tab in one block switches all of them, and the tab stays where the reader clicked it.
    const tab = page.locator(".vp-code-group label", { hasText: /^pnpm$/ }).first();
    await tab.scrollIntoViewIfNeeded();
    const before = (await tab.boundingBox())?.y ?? 0;
    await tab.click();
    const afterTab = await shown();
    expect([afterTab.length >= 3, afterTab.every((g) => g.label === "pnpm" && g.matches)]).toEqual([
      true,
      true,
    ]);
    expect(Math.abs(((await tab.boundingBox())?.y ?? 0) - before)).toBeLessThan(2);
    // The choice holds on the next page; the switch in the navigation bar changes it again.
    await page.goto(`${base}/how-to/gates-ci`);
    expect((await shown()).every((g) => g.label === "pnpm" && g.matches)).toBe(true);
    await page.locator(".VPNavBar .mx-pm-select select").selectOption("bun");
    expect((await shown()).every((g) => g.label === "bun" && g.matches)).toBe(true);
    // The switch fits in the navigation bar.
    const box = await page.locator(".VPNavBar .mx-pm-select").boundingBox();
    expect(box !== null && box.x + box.width <= 1280).toBe(true);
    // The buttons on the installation page show the same choice.
    await page.goto(`${base}/guide/installation`);
    expect(await page.locator('.vp-doc .mx-pm button[aria-checked="true"]').textContent()).toContain("bun");
    await page.close();
  }, 60_000);

  test("the sidebar is the whole table of contents, and Next chapter leads through every page", async () => {
    const config = (await import("../site/.vitepress/config.ts")).default as {
      themeConfig: { nav: unknown[]; sidebar: { text: string; items: { link: string }[] }[] };
    };
    const order = config.themeConfig.sidebar.flatMap((g) => g.items.map((i) => i.link));
    const pages = [...new Bun.Glob("**/*.md").scanSync({ cwd: join(ROOT, "site") })]
      .filter((f) => f !== "index.md")
      .map((f) => `/${f.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`);
    expect([config.themeConfig.nav, [...order].sort()]).toEqual([[], pages.sort()]);

    const base = `http://localhost:${server.port}`;
    const page = await (await browser()).newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${base}/`);
    await page.locator(".VPHero a", { hasText: "Get started" }).click();
    await page.waitForURL((u) => u.pathname === order[0]);
    const visited: string[] = [];
    for (let i = 0; i <= order.length; i++) {
      visited.push(new URL(page.url()).pathname);
      // Each page has one pager: the next chapter, until the last page.
      const next = page.locator(".VPDocFooter .pager-link.next");
      if ((await next.count()) === 0) break;
      const href = (await next.getAttribute("href")) as string;
      await next.click();
      await page.waitForURL((u) => u.pathname === href);
      await page.locator(`.VPDocFooter .pager-link.prev[href="${visited.at(-1)}"]`).waitFor();
    }
    expect(visited).toEqual(order);
    // The chapter of the open page is expanded; the others stay collapsed.
    await page.goto(`${base}/how-to/worktrees`);
    const open = await page.locator(".VPSidebarItem.level-0:not(.collapsed) > .item .text").allTextContents();
    expect(open.map((t) => t.trim())).toEqual(["Get started", "Guides"]);
    await page.close();
  }, 90_000);
});
