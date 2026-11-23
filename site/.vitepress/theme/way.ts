import { ref } from "vue";

/** The two ways to install and use MetatorAI the docs describe, in the switch's order. */
export const WAYS = [
  { id: "app", label: "Desktop app", sub: "the window; the metator command is inside it" },
  { id: "cli", label: "Terminal only", sub: "the metator command, no window" },
] as const;
export type Way = (typeof WAYS)[number]["id"];

const KEY = "metator-docs-way";
const isWay = (v: unknown): v is Way => WAYS.some((w) => w.id === v);

/** The reader's way, shared by every page (the desktop app until chosen). */
export const way = ref<Way>("app");

/** `?way=cli` in a link chooses the way for the reader; else what they chose before. */
export function loadWay(): void {
  const asked = new URLSearchParams(window.location.search).get("way");
  if (isWay(asked)) {
    chooseWay(asked);
    return;
  }
  try {
    const saved = localStorage.getItem(KEY);
    if (isWay(saved)) way.value = saved;
  } catch {
    // Storage can be blocked; the default stays.
  }
}

export function chooseWay(w: Way): void {
  way.value = w;
  try {
    localStorage.setItem(KEY, w);
  } catch {
    // Storage can be blocked; the choice lasts for this page view.
  }
}
