import { z } from "zod";
import { defineDocument } from "./versioned.ts";

/**
 * The terminal runtime's layout (R1, ADR-0080): a workspace per run (or per
 * repository), tabs inside it, panes inside tabs. A pane is a real terminal with a role; the
 * daemon keeps this document in `.metator/layout.json` and brings every pane back after a restart.
 */
export const PANE_ROLES = ["conductor", "worker", "apps", "gate", "shell"] as const;
export type PaneRole = (typeof PANE_ROLES)[number];

const WorkspaceId = z.string().regex(/^w\d+$/);
const TabId = z.string().regex(/^w\d+:t\d+$/);
const PaneId = z.string().regex(/^w\d+:p\d+$/);

/** An AI host's interactive session: resumed by `sessionId` after a restart. */
const HostProcessSchema = z.strictObject({
  kind: z.literal("host"),
  host: z.string().min(1),
  agent: z.string().min(1),
  prompt: z.string(),
  sessionId: z.string().optional(),
});
/** Any other program (a shell, `metator env logs`): started again as it was. */
const CommandProcessSchema = z.strictObject({ kind: z.literal("command"), argv: z.array(z.string()).min(1) });

export const PaneSchema = z.strictObject({
  id: PaneId,
  tab: TabId,
  role: z.enum(PANE_ROLES),
  label: z.string().min(1),
  /** Absolute working directory. */
  cwd: z.string().min(1),
  process: z.discriminatedUnion("kind", [HostProcessSchema, CommandProcessSchema]),
  runId: z.string().optional(),
  /** A worker pane: who it is in the run and which stage it works. */
  worker: z.strictObject({ name: z.string().min(1), stage: z.string().min(1) }).optional(),
  createdAt: z.iso.datetime(),
});
export type Pane = z.output<typeof PaneSchema>;
export type PaneProcess = Pane["process"];

const TabV1Schema = z.strictObject({
  id: TabId,
  label: z.string().min(1),
  panes: z.array(PaneId),
});

/**
 * How a tab's panes share its area (S6): a leaf is a pane, a node splits its
 * area in two along a direction at a ratio (the first part's share). Without a tree a client
 * lays the panes out as an even grid.
 */
export type SplitNode =
  | { readonly pane: string }
  | { readonly dir: "row" | "column"; readonly ratio: number; readonly a: SplitNode; readonly b: SplitNode };
export const SplitNodeSchema: z.ZodType<SplitNode> = z.lazy(() =>
  z.union([
    z.strictObject({ pane: PaneId }),
    z.strictObject({
      dir: z.enum(["row", "column"]),
      ratio: z.number().min(0.1).max(0.9),
      a: SplitNodeSchema,
      b: SplitNodeSchema,
    }),
  ]),
);

/** v2 (S6) adds the optional split tree. Never change v1. */
export const TabSchema = z.strictObject({
  ...TabV1Schema.shape,
  tree: SplitNodeSchema.optional(),
});
export type Tab = z.output<typeof TabSchema>;

const workspaceFields = {
  id: WorkspaceId,
  label: z.string().min(1),
  cwd: z.string().min(1),
  runId: z.string().optional(),
  /** The workspace this one belongs under (a run's worktree under its repository). */
  group: WorkspaceId.optional(),
};
// `createdAt` after `tabs`, as v1 was frozen: the snapshot compares the field order too.
const WorkspaceV1Schema = z.strictObject({
  ...workspaceFields,
  tabs: z.array(TabV1Schema).min(1),
  createdAt: z.iso.datetime(),
});
export const WorkspaceSchema = z.strictObject({
  ...workspaceFields,
  tabs: z.array(TabSchema).min(1),
  createdAt: z.iso.datetime(),
});
export type Workspace = z.output<typeof WorkspaceSchema>;

const NextSchema = z.strictObject({
  workspace: z.number().int().positive(),
  pane: z.number().int().positive(),
});
const LayoutV1Schema = z.strictObject({
  workspaces: z.array(WorkspaceV1Schema),
  panes: z.array(PaneSchema),
  next: NextSchema,
});
export const LayoutSchema = z.strictObject({
  workspaces: z.array(WorkspaceSchema),
  panes: z.array(PaneSchema),
  /** Counters, so an id is never reused after a close. */
  next: NextSchema,
});
export type Layout = z.output<typeof LayoutSchema>;

export const LayoutDocument = defineDocument("Layout", {
  history: [{ schema: LayoutV1Schema }],
  latest: LayoutSchema,
  // Every tab field of v2 is optional: a v1 layout is a v2 layout with even grids.
  upgrade: (previous) => previous,
  hint: "Written by the daemon (`metator serve`); do not edit by hand.",
});

export const EMPTY_LAYOUT: Layout = { workspaces: [], panes: [], next: { workspace: 1, pane: 1 } };

export const workspaceOfRun = (layout: Layout, runId: string): Workspace | undefined =>
  layout.workspaces.find((w) => w.runId === runId);
export const paneOf = (layout: Layout, id: string): Pane | undefined => layout.panes.find((p) => p.id === id);
export const panesOf = (layout: Layout, workspace: string): Pane[] =>
  layout.panes.filter((p) => p.tab.startsWith(`${workspace}:`));
export const workspaceOfPane = (pane: Pick<Pane, "id">): string => pane.id.split(":")[0] as string;

/** A workspace with its first tab. */
export function addWorkspace(
  layout: Layout,
  input: {
    readonly label: string;
    readonly cwd: string;
    readonly runId?: string;
    readonly group?: string;
    readonly tab?: string;
    readonly at: string;
  },
): { readonly layout: Layout; readonly workspace: Workspace } {
  const id = `w${layout.next.workspace}`;
  const workspace: Workspace = {
    id,
    label: input.label,
    cwd: input.cwd,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.group ? { group: input.group } : {}),
    tabs: [{ id: `${id}:t1`, label: input.tab ?? (input.runId ? "run" : "main"), panes: [] }],
    createdAt: input.at,
  };
  return {
    layout: {
      ...layout,
      workspaces: [...layout.workspaces, workspace],
      next: { ...layout.next, workspace: layout.next.workspace + 1 },
    },
    workspace,
  };
}

/** Another tab of a workspace; its id counts the workspace's tabs ever made. */
export function addTab(
  layout: Layout,
  workspace: string,
  label: string,
): { readonly layout: Layout; readonly tab: Tab } | undefined {
  const w = layout.workspaces.find((x) => x.id === workspace);
  if (!w) return undefined;
  const n = Math.max(0, ...w.tabs.map((t) => Number(t.id.split(":t")[1]))) + 1;
  const tab: Tab = { id: `${workspace}:t${n}`, label, panes: [] };
  return {
    layout: {
      ...layout,
      workspaces: layout.workspaces.map((x) => (x.id === workspace ? { ...x, tabs: [...x.tabs, tab] } : x)),
    },
    tab,
  };
}

/** A pane in a tab (the workspace's first tab when none is named). */
export function addPane(
  layout: Layout,
  input: {
    readonly workspace: string;
    readonly tab?: string;
    readonly role: PaneRole;
    readonly label: string;
    readonly cwd: string;
    readonly process: PaneProcess;
    readonly runId?: string;
    readonly worker?: Pane["worker"];
    readonly at: string;
    /** Where the pane goes in the tab's split tree: beside this pane, in this direction (S6). */
    readonly split?: { readonly target: string; readonly dir: "row" | "column" };
  },
): { readonly layout: Layout; readonly pane: Pane } | undefined {
  const w = layout.workspaces.find((x) => x.id === input.workspace);
  const tab = input.tab
    ? w?.tabs.find((t) => t.id === input.tab)
    : input.split
      ? w?.tabs.find((t) => t.panes.includes(input.split?.target ?? ""))
      : w?.tabs[0];
  if (!w || !tab) return undefined;
  if (input.split && !tab.panes.includes(input.split.target)) return undefined;
  const pane: Pane = {
    id: `${w.id}:p${layout.next.pane}`,
    tab: tab.id,
    role: input.role,
    label: input.label,
    cwd: input.cwd,
    process: input.process,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.worker ? { worker: input.worker } : {}),
    createdAt: input.at,
  };
  return {
    layout: {
      ...layout,
      workspaces: layout.workspaces.map((x) =>
        x.id === w.id
          ? {
              ...x,
              tabs: x.tabs.map((t) =>
                t.id === tab.id
                  ? { ...t, panes: [...t.panes, pane.id], ...treeAfterAdd(t, pane.id, input.split) }
                  : t,
              ),
            }
          : x,
      ),
      panes: [...layout.panes, pane],
      next: { ...layout.next, pane: layout.next.pane + 1 },
    },
    pane,
  };
}

/** The pane's record changed in place (its session id after a start). */
export const updatePane = (layout: Layout, id: string, change: (pane: Pane) => Pane): Layout => ({
  ...layout,
  panes: layout.panes.map((p) => (p.id === id ? change(p) : p)),
});

/** Without the pane; an emptied tab goes too unless it is the workspace's last. */
export function removePane(layout: Layout, id: string): Layout {
  const pane = paneOf(layout, id);
  if (!pane) return layout;
  return {
    ...layout,
    panes: layout.panes.filter((p) => p.id !== id),
    workspaces: layout.workspaces.map((w) => {
      if (!pane.tab.startsWith(`${w.id}:`)) return w;
      const tabs = w.tabs.map((t) =>
        t.id === pane.tab ? { ...t, panes: t.panes.filter((p) => p !== id), ...treeAfterRemove(t, id) } : t,
      );
      const kept = tabs.filter((t) => t.panes.length > 0 || tabs.length === 1);
      return { ...w, tabs: kept.length > 0 ? kept : [tabs[0] as Tab] };
    }),
  };
}

/** Without the workspace and every pane in it. */
export const removeWorkspace = (layout: Layout, id: string): Layout => ({
  ...layout,
  workspaces: layout.workspaces.filter((w) => w.id !== id),
  panes: layout.panes.filter((p) => !p.tab.startsWith(`${id}:`)),
});

/** Terminal escapes (colors, cursor moves, titles): CSI, OSC, charset and keypad sequences. */
const ESC = "\u001b";
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^\u0007${ESC}]*(?:\u0007|${ESC}\\\\)|${ESC}[()][A-Za-z0-9]|${ESC}[=>]`,
  "g",
);

/** Terminal text without its ANSI escapes, for reading and matching. */
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/** The last `lines` lines of a text. */
export const tailLines = (text: string, lines: number): string => text.split("\n").slice(-lines).join("\n");

/** The panes of a split tree, left to right, top to bottom. */
export const treeLeaves = (node: SplitNode): string[] =>
  "pane" in node ? [node.pane] : [...treeLeaves(node.a), ...treeLeaves(node.b)];

/** A tab's tree, or an even one built from its pane order (columns first, then rows). */
export function treeOf(tab: Pick<Tab, "panes" | "tree">): SplitNode | undefined {
  if (tab.tree) return tab.tree;
  return balanced(tab.panes, "row");
}

function balanced(panes: readonly string[], dir: "row" | "column"): SplitNode | undefined {
  if (panes.length === 0) return undefined;
  if (panes.length === 1) return { pane: panes[0] as string };
  const half = Math.ceil(panes.length / 2);
  const next = dir === "row" ? "column" : "row";
  return {
    dir,
    ratio: half / panes.length,
    a: balanced(panes.slice(0, half), next) as SplitNode,
    b: balanced(panes.slice(half), next) as SplitNode,
  };
}

/** The tree with `target`'s area split in two: `target` keeps the first half, `added` takes the second. */
export function splitInTree(
  node: SplitNode,
  target: string,
  added: string,
  dir: "row" | "column",
): SplitNode {
  if ("pane" in node) return node.pane === target ? { dir, ratio: 0.5, a: node, b: { pane: added } } : node;
  return { ...node, a: splitInTree(node.a, target, added, dir), b: splitInTree(node.b, target, added, dir) };
}

/** The tree without a pane; its sibling takes the whole area. Undefined when it was the last pane. */
export function removeFromTree(node: SplitNode, pane: string): SplitNode | undefined {
  if ("pane" in node) return node.pane === pane ? undefined : node;
  const a = removeFromTree(node.a, pane);
  const b = removeFromTree(node.b, pane);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

/** The ratio of the node at a path (`a`/`b` steps from the root) changed; out of range is clamped. */
export function resizeInTree(node: SplitNode, path: readonly ("a" | "b")[], ratio: number): SplitNode {
  if ("pane" in node) return node;
  const clamped = Math.min(0.9, Math.max(0.1, ratio));
  if (path.length === 0) return { ...node, ratio: clamped };
  const [step, ...rest] = path;
  return step === "a"
    ? { ...node, a: resizeInTree(node.a, rest, ratio) }
    : { ...node, b: resizeInTree(node.b, rest, ratio) };
}

/** A tree fits a tab when its leaves are exactly the tab's panes. */
export const treeFits = (tree: SplitNode, panes: readonly string[]): boolean => {
  const leaves = treeLeaves(tree);
  return leaves.length === panes.length && panes.every((p) => leaves.includes(p));
};

function treeAfterAdd(
  tab: Tab,
  pane: string,
  split: { readonly target: string; readonly dir: "row" | "column" } | undefined,
): { tree?: SplitNode } {
  if (split) {
    const base = treeOf(tab) as SplitNode;
    return { tree: splitInTree(base, split.target, pane, split.dir) };
  }
  // A pane added without a place: an explicit tree gets it beside everything, an even grid stays even.
  if (!tab.tree) return {};
  const n = tab.panes.length + 1;
  return { tree: { dir: "row", ratio: Math.max(0.1, Math.min(0.9, (n - 1) / n)), a: tab.tree, b: { pane } } };
}

function treeAfterRemove(tab: Tab, pane: string): { tree?: SplitNode } {
  if (!tab.tree) return {};
  const tree = removeFromTree(tab.tree, pane);
  return tree ? { tree } : {};
}
