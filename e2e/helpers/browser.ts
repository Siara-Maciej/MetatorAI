import { type Browser, chromium, type Page } from "playwright";

let shared: Promise<Browser> | undefined;

/** One Chromium per test process; closed by the caller's afterAll via closeBrowser(). */
export function browser(): Promise<Browser> {
  shared ??= chromium.launch();
  return shared;
}

export async function closeBrowser(): Promise<void> {
  if (shared) await (await shared).close();
  shared = undefined;
}

/**
 * Home shows one decision at a time: steps through the queue with Next until what Home shows
 * (the card with its Details: ids, stage, run; an escalated run's card) holds every word, and
 * returns the decision card.
 */
export async function decisionOnHome(page: Page, words: readonly string[], ms = 30_000) {
  const card = page.getByRole("article", { name: "decision card" });
  const end = Date.now() + ms;
  for (;;) {
    const text =
      (await page
        .locator(".home")
        .textContent({ timeout: 1000 })
        .catch(() => "")) ?? "";
    if (words.every((w) => text.includes(w))) return card;
    if (Date.now() > end) throw new Error(`no decision on Home with ${words.join(" + ")}`);
    const next = page.getByRole("button", { name: "Next ›" });
    if ((await next.count()) > 0 && (await next.isEnabled())) await next.click();
    await Bun.sleep(400);
  }
}
