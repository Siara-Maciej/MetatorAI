/**
 * Visual e2e for the README graphics, rendered in real Chromium the way GitHub shows them (<img>).
 * Catches what eyes miss: text overflowing its box with wider fonts, overlapping labels,
 * broken animations, drift from the generator, and README links to missing images.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSETS } from "../scripts/assets/generate.ts";
import { browser, closeBrowser } from "./helpers/browser.ts";

const ROOT = join(import.meta.dir, "..");
const NAMES = Object.keys(ASSETS) as (keyof typeof ASSETS)[];
/** Wide (DejaVu), Arial-metric (Liberation/FreeSans) and the narrow default (Inter): what README viewers really get. */
const FONTS = ["DejaVu Sans", "Liberation Sans", "FreeSans", "Inter"];
const tmpDirs: string[] = [];

afterAll(async () => {
  await closeBrowser();
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("README assets: source of truth", () => {
  for (const name of NAMES) {
    test(`${name}.svg matches the generator output (run \`bun run assets\` after edits)`, async () => {
      const committed = await Bun.file(join(ROOT, "assets", `${name}.svg`)).text();
      expect(committed).toBe(ASSETS[name]());
    });

    test(`${name}.svg is safe to embed on GitHub: no scripts, no external references`, () => {
      const svg = ASSETS[name]();
      expect(svg).not.toMatch(/<script|on\w+=|href="https?:|@import|url\(https?:/i);
      expect(svg).toMatch(/<title>[^<]+<\/title>/);
      expect(svg).toMatch(/role="img" aria-label="[^"]+"/);
    });
  }

  test("every image referenced by README.md exists", async () => {
    const readme = await Bun.file(join(ROOT, "README.md")).text();
    const srcs = [...readme.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1] as string);
    expect(srcs.length).toBeGreaterThanOrEqual(NAMES.length);
    for (const src of srcs) {
      if (/^https?:/.test(src)) continue;
      expect(await Bun.file(join(ROOT, src)).exists()).toBe(true);
    }
  });

  test("README contains no Mermaid blocks (they render inconsistently; use generated SVGs)", async () => {
    expect(await Bun.file(join(ROOT, "README.md")).text()).not.toContain("```mermaid");
  });
});

describe("README assets: layout in real fonts", () => {
  for (const name of NAMES) {
    for (const font of FONTS) {
      test(`${name}.svg · ${font}: text fits its box, stays on canvas, labels do not collide`, async () => {
        const page = await (await browser()).newPage();
        await page.setContent(
          `<style>svg text { font-family: '${font}', sans-serif !important; }</style>${ASSETS[name]()}`,
        );
        const problems = await page.evaluate(() => {
          const svg = document.querySelector("svg") as SVGSVGElement;
          const W = svg.viewBox.baseVal.width;
          const H = svg.viewBox.baseVal.height;
          const boxes = [...svg.querySelectorAll("rect")]
            .filter(
              (r) => !r.closest("clipPath, defs") && r.getBBox().width > 20 && r.getBBox().width < W - 40,
            )
            .map((r) => r.getBBox());
          const texts = [...svg.querySelectorAll("text")]
            .filter((t) => (t.textContent ?? "").trim() !== "")
            .map((t) => ({ label: (t.textContent ?? "").trim(), b: t.getBBox() }));
          const out: string[] = [];
          for (const { label, b } of texts) {
            if (b.x < 4 || b.x + b.width > W - 4 || b.y < 0 || b.y + b.height > H)
              out.push(`off-canvas: "${label}"`);
            const cx = b.x + b.width / 2;
            const cy = b.y + b.height / 2;
            const host = boxes
              .filter((r) => cx > r.x && cx < r.x + r.width && cy > r.y && cy < r.y + r.height)
              .sort((p, q) => p.width * p.height - q.width * q.height)[0];
            if (host && (b.x < host.x + 2 || b.x + b.width > host.x + host.width - 2)) {
              out.push(`overflows its box: "${label}"`);
            }
          }
          for (const t of svg.querySelectorAll("text[clip-path]")) {
            const id = (t.getAttribute("clip-path") ?? "").match(/#([^)]+)/)?.[1] ?? "";
            const values =
              svg.querySelector(`#${id} animate[attributeName=width]`)?.getAttribute("values") ?? "0";
            const maxClip = Math.max(...values.split(";").map(Number));
            if (maxClip < (t as SVGTextElement).getBBox().width + 4)
              out.push(`clipped text cut off: "${t.textContent}"`);
          }
          for (let i = 0; i < texts.length; i++) {
            for (let j = i + 1; j < texts.length; j++) {
              const p = (texts[i] as (typeof texts)[number]).b;
              const q = (texts[j] as (typeof texts)[number]).b;
              const overlapX = Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x);
              const overlapY = Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);
              if (overlapX > 1 && overlapY > 3)
                out.push(`collision: "${texts[i]?.label}" × "${texts[j]?.label}"`);
            }
          }
          return out;
        });
        await page.close();
        expect(problems).toEqual([]);
      });
    }
  }
});

describe("README assets: animation", () => {
  for (const name of NAMES) {
    test(`${name}.svg animates when embedded as <img> (frames differ over time)`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "metator-assets-"));
      tmpDirs.push(dir);
      const svgPath = join(dir, `${name}.svg`);
      await Bun.write(svgPath, ASSETS[name]());
      await Bun.write(
        join(dir, "index.html"),
        `<body style="margin:0"><img id="i" src="${name}.svg" width="960"></body>`,
      );
      const page = await (await browser()).newPage({ viewport: { width: 980, height: 480 } });
      await page.goto(`file://${join(dir, "index.html")}`);
      await page.waitForFunction(() => (document.getElementById("i") as HTMLImageElement).complete);
      await page.waitForTimeout(600);
      const first = await page.locator("#i").screenshot();
      await page.waitForTimeout(2200);
      const second = await page.locator("#i").screenshot();
      await page.close();
      expect(first.length).toBeGreaterThan(1000); // rendered, not a broken-image icon
      expect(Buffer.compare(first, second)).not.toBe(0);
    }, 15_000);
  }
});
