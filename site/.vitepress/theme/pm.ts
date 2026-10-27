import { ref } from "vue";

/** The package managers the docs show commands for, in tab order. */
export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

const KEY = "metator-docs-pm";
const isPm = (v: unknown): v is PackageManager => PACKAGE_MANAGERS.includes(v as PackageManager);

/** The reader's package manager, shared by every page and every code group (npm until chosen). */
export const packageManager = ref<PackageManager>("npm");

export function loadPackageManager(): void {
  try {
    const saved = localStorage.getItem(KEY);
    if (isPm(saved)) packageManager.value = saved;
  } catch {
    // Storage can be blocked; the default stays.
  }
}

export function choosePackageManager(pm: PackageManager): void {
  packageManager.value = pm;
  try {
    localStorage.setItem(KEY, pm);
  } catch {
    // Storage can be blocked; the choice lasts for this page view.
  }
  showPackageManager(pm);
}

/** Tab labels of a VitePress code group, in order. */
function labelsOf(group: Element): (string | undefined)[] {
  return [...group.querySelectorAll(":scope > .tabs > input")].map((input) =>
    group.querySelector(`label[for="${input.id}"]`)?.textContent?.trim(),
  );
}

/**
 * Selects the reader's package manager in every code group tabbed by package manager. It sets
 * the state directly instead of clicking, because VitePress scrolls a clicked tab into view.
 */
export function showPackageManager(pm: PackageManager = packageManager.value): void {
  for (const group of document.querySelectorAll(".vp-code-group")) {
    const index = labelsOf(group).indexOf(pm);
    if (index < 0) continue;
    const inputs = group.querySelectorAll<HTMLInputElement>(":scope > .tabs > input");
    const input = inputs[index];
    if (input) input.checked = true;
    const blocks = group.querySelector(":scope > .blocks")?.children ?? [];
    for (const [i, block] of [...blocks].entries()) block.classList.toggle("active", i === index);
  }
}

/** A click on a package-manager tab anywhere switches the whole documentation. */
export function followTabClicks(): void {
  window.addEventListener("click", (e) => {
    const el = e.target as HTMLElement | null;
    if (!el?.matches(".vp-code-group > .tabs > input")) return;
    const group = el.closest(".vp-code-group");
    const label = group?.querySelector(`label[for="${el.id}"]`)?.textContent?.trim();
    if (isPm(label) && label !== packageManager.value) choosePackageManager(label);
  });
}
