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

/** Serves the built site like GitHub Pages: `/start/x` → `start/x.html`, `/` → `index.html`. */
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
    const reference = await read("site/reference/commands.md");
    for (const command of ["metator run approve", "metator system lint", "metator findings to-github"])
      expect(reference).toContain(`### \`${command}\``);
  });

  test("every shipped agent, skill and document kind is on the site", async () => {
    // The table is rendered from metator/agents at build time: every agent must be in the HTML.
    const gallery = await Bun.file(join(out, "repo/agents.html")).text();
    for await (const file of new Bun.Glob("metator/agents/*.md").scan({ cwd: ROOT }))
      expect(gallery).toContain(`data-agent="${file.slice("metator/agents/".length, -3)}"`);
    const skills = await read("site/repo/agents.md");
    for await (const file of new Bun.Glob("metator/skills/*/SKILL.md").scan({ cwd: ROOT }))
      expect(skills).toContain(`\`${file.split("/")[2]}\``);
    const documents = await read("site/reference/documents.md");
    for await (const file of new Bun.Glob("docs/metator/schemas/*.v*.json").scan({ cwd: ROOT })) {
      if (file.endsWith(".example.json")) continue;
      const kind = file.slice("docs/metator/schemas/".length).split(".")[0] as string;
      expect(documents).toContain(`\`${kind}\``);
    }
  });

  test("workflow diagrams show exactly the stages of the shipped specs", async () => {
    const pages: Record<string, string> = {
      "mt-feature": "use/feature.html",
      "mt-bugfix": "use/bugfix.html",
      "mt-refactor": "use/refactor.html",
      "mt-pr-review": "use/review.html",
      "mt-self-review": "use/review.html",
      "mt-system-change": "use/system.html",
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

  test("the built site renders every section in a real browser without errors, and nothing on it moves", async () => {
    const page = await (await browser()).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const base = `http://localhost:${server.port}`;
    const { sections, pathOf } = await import("../site/.vitepress/config.ts");
    // The home page is a plain document that leads into the four sections.
    await page.goto(`${base}/`);
    const heading = async () =>
      ((await page.locator("main h1").first().textContent()) ?? "").replace(/[\s\u200b]+/g, " ").trim();
    expect(await heading()).toBe("MetatorAI");
    for (const s of sections)
      expect(await page.locator("main li a", { hasText: new RegExp(`^${s.text}$`) }).count()).toBe(1);
    // Every page of every section answers, and its heading is its name in the sidebar.
    for (const s of sections)
      for (const item of s.items) {
        const response = await page.goto(`${base}${pathOf(s.base, item.link)}`);
        expect([item.text, response?.status()]).toEqual([item.text, 200]);
        expect(await heading()).toBe(item.text);
      }
    // On a phone no page is wider than the screen: wide tables and code scroll inside themselves.
    await page.setViewportSize({ width: 390, height: 844 });
    const wide: string[] = [];
    for (const s of sections)
      for (const item of s.items) {
        await page.goto(`${base}${pathOf(s.base, item.link)}`);
        if ((await page.evaluate(() => document.documentElement.scrollWidth)) > 390) wide.push(item.text);
      }
    expect(wide).toEqual([]);
    // Nothing moves on its own: no page carries an endless animation.
    for (const path of ["/", "/use/feature", "/repo/agents"]) {
      await page.goto(`${base}${path}`);
      // A transition after a click ends on its own; an endless animation is what must not exist.
      const endless = await page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY).length,
      );
      expect([path, endless]).toEqual([path, 0]);
    }
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

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
    expect(groups.length).toBeGreaterThanOrEqual(3);
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
    await page.goto(`${base}/guide/install`);
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
    await page.goto(`${base}/repo/gates-ci`);
    expect((await shown()).every((g) => g.label === "pnpm" && g.matches)).toBe(true);
    await page.locator(".VPNavBar .mx-pm-select select").selectOption("bun");
    expect((await shown()).every((g) => g.label === "bun" && g.matches)).toBe(true);
    // The switch fits in the navigation bar next to the sections.
    const box = await page.locator(".VPNavBar .mx-pm-select").boundingBox();
    expect(box !== null && box.x + box.width <= 1280).toBe(true);
    // The buttons on the installation page show the same choice.
    await page.goto(`${base}/guide/install`);
    expect(await page.locator('.vp-doc .mx-pm button[aria-checked="true"]').textContent()).toContain("bun");
    await page.close();
  }, 60_000);

  test("four sections in the top bar, each sidebar covers its pages, and Next leads through each section", async () => {
    const { sections, pathOf } = await import("../site/.vitepress/config.ts");
    const config = (await import("../site/.vitepress/config.ts")).default as {
      themeConfig: { nav: { text: string; link: string }[]; sidebar: Record<string, unknown> };
    };
    // Every page of the site is in exactly one section's sidebar, and every entry is a page.
    const inSidebars = sections.flatMap((s) => s.items.map((i) => pathOf(s.base, i.link)));
    const pages = [...new Bun.Glob("**/*.md").scanSync({ cwd: join(ROOT, "site") })]
      .filter((f) => f !== "index.md")
      .map((f) => `/${f.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`);
    expect([...inSidebars].sort()).toEqual(pages.sort());
    expect(config.themeConfig.nav.map((n) => n.text)).toEqual(["Guide", "App", "Repository", "Reference"]);
    expect(Object.keys(config.themeConfig.sidebar).sort()).toEqual(sections.map((s) => s.base).sort());

    const base = `http://localhost:${server.port}`;
    const page = await (await browser()).newPage({ viewport: { width: 1280, height: 900 } });
    // The home page leads into the guide; from there Next walks each section to its last page.
    await page.goto(`${base}/`);
    await page.locator("main a", { hasText: "First run" }).click();
    await page.waitForURL((u) => u.pathname === "/guide/first-run");
    for (const section of sections) {
      const order = section.items.map((i) => pathOf(section.base, i.link));
      await page.goto(`${base}${order[0]}`);
      const visited: string[] = [];
      for (let i = 0; i < order.length; i++) {
        visited.push(new URL(page.url()).pathname);
        // Each page has one pager: the next page of the section, until the last page. After a
        // client-side navigation the footer renders a moment later, so wait for it.
        const next = page.locator(".VPDocFooter .pager-link.next");
        if (i === order.length - 1) {
          if (order.length > 1) await page.locator(".VPDocFooter .pager-link.prev").waitFor();
          expect(await next.count()).toBe(0);
          break;
        }
        await next.waitFor({ timeout: 10_000 });
        const href = (await next.getAttribute("href")) as string;
        await next.click();
        await page.waitForURL((u) => u.pathname === href);
        await page.locator(`.VPDocFooter .pager-link.prev[href="${visited.at(-1)}"]`).waitFor();
      }
      expect([section.text, visited]).toEqual([section.text, order]);
    }
    // The top bar marks the open section.
    await page.goto(`${base}/repo/systems`);
    expect(await page.locator(".VPNavBarMenuLink.active").textContent()).toContain("Repository");
    await page.close();
  }, 180_000);
});
