import { type Browser, chromium } from "playwright";

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
