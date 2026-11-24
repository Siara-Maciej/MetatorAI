/**
 * The app's places as hash routes, and a run's tabs: parsed and written here only (pure, tested).
 */

/**
 * The tabs of the one page about a run, in the order of its header. A step's plan, its
 * artefacts and its question are on its Overview; there is no Plan tab.
 */
export const RUN_TABS = [
  { tab: "overview", label: "Overview", key: "o" },
  { tab: "terminal", label: "Terminal", key: "t" },
  { tab: "changes", label: "Changes", key: "d" },
  { tab: "activity", label: "Activity", key: "l" },
] as const;
export type RunTab = (typeof RUN_TABS)[number]["tab"];
/**
 * The tabs a page shows: a task's page (a system run, a run with child runs) is Overview ·
 * Changes · Activity, its steps have the terminals; a step's page (or a run of its own) all four.
 */
export const tabsOf = (task: boolean): readonly (typeof RUN_TABS)[number][] =>
  task ? RUN_TABS.filter((t) => t.tab !== "terminal") : RUN_TABS;
/** The two parts of the Overview place: the daemon with its figures, and what links the runs. */
export type OverviewTab = "daemon" | "dependencies" | "system";
/**
 * The hash route, one per place: `#/inbox[/<run>%2F<question>]`, `#/run/<run>[/<tab>[/<pane,
 * file or edit>]]`, `#/grid[/<group>|/pane:<pane>]` (Terminals), `#/overview[/dependencies]`,
 * `#/mrs[/<id>]`, `#/settings`, `#/backlog`, `#/thread/<id>`. The routes of the four screens a run once had
 * (`#/session`, `#/plan`, `#/review`, `#/briefing`) and of the two the Overview once was
 * (`#/supervisor`, `#/graph`) still parse: they land on the tab that holds what they showed.
 */
export type Route =
  | { readonly screen: "inbox"; readonly pick?: string }
  | {
      readonly screen: "run";
      readonly runId: string;
      readonly tab: RunTab;
      /** The pane the Terminal tab shows first. */
      readonly pane?: string;
      /** The file the Changes tab shows. */
      readonly file?: string;
    }
  | {
      readonly screen: "grid";
      /** The workspaces' tabs (`#/grid/workspaces`, or a workspace group). */
      readonly group?: string;
      readonly pane?: string;
      /** A task's terminals (`#/grid/task/<run>`), and one of its sessions (`/<child run>`). */
      readonly task?: string | undefined;
      readonly session?: string | undefined;
    }
  | { readonly screen: "overview"; readonly tab: OverviewTab }
  /** Reviews (round 18): watched MRs and my MRs, one chosen; a place of its own next to Backlog. */
  | { readonly screen: "reviews"; readonly id?: string }
  | { readonly screen: "settings" }
  /** The Backlog, with one item chosen (round 17: a plan view's "Open its Backlog item"). */
  | { readonly screen: "backlog"; readonly id?: string }
  | { readonly screen: "board"; readonly task?: string }
  /** A thread (round 16): its chat terminal as the main view. */
  | { readonly screen: "thread"; readonly id: string }
  /** Add repository (round 20): pick a folder, inspect it, set it up, open it. */
  | { readonly screen: "add" }
  /** The app's own settings (round 20): the metator command and the repositories it knows. */
  | { readonly screen: "app" };
/** The tab an old run route showed. */
const OLD_RUN_ROUTES: Readonly<Record<string, RunTab>> = {
  session: "terminal",
  plan: "overview",
  review: "changes",
  briefing: "overview",
};
/** A run route from the parts after its tab: a pane for the terminal, a file path for the changes. */
function runRoute(runId: string, tab: RunTab, rest: readonly string[]): Route {
  const pane = tab === "terminal" ? rest[0] : undefined;
  const file = tab === "changes" ? rest.join("/") : "";
  return {
    screen: "run",
    runId,
    tab,
    ...(pane ? { pane } : {}),
    ...(file ? { file } : {}),
  };
}
export function parseRoute(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter((p) => p !== "")
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  const [screen, arg] = parts;
  if (screen === undefined) return { screen: "inbox" };
  const old = OLD_RUN_ROUTES[screen];
  if (old) return arg ? runRoute(arg, old, parts.slice(2)) : { screen: "inbox" };
  switch (screen) {
    case "run": {
      if (!arg) return { screen: "inbox" };
      // The old Plan tab is on the Overview now.
      const tab = RUN_TABS.find((t) => t.tab === parts[2])?.tab;
      return runRoute(arg, tab ?? "overview", parts.slice(3));
    }
    case "grid":
      if (arg === "task" && parts[2])
        return parts[3]
          ? { screen: "grid", task: parts[2], session: parts[3] }
          : { screen: "grid", task: parts[2] };
      return arg
        ? arg.startsWith("pane:")
          ? { screen: "grid", pane: arg.slice("pane:".length) }
          : { screen: "grid", group: arg }
        : { screen: "grid" };
    case "overview":
      return {
        screen: "overview",
        tab: arg === "dependencies" ? "dependencies" : arg === "system" ? "system" : "daemon",
      };
    case "supervisor":
      return { screen: "overview", tab: "daemon" };
    case "graph":
      return { screen: "overview", tab: "dependencies" };
    case "settings":
      // Settings holds the places that are not daily work: the System (the daemon, the
      // dependencies, the system map). The Reviews were here before round 18.
      if (arg === "system") {
        const t = parts[2];
        return {
          screen: "overview",
          tab: t === "dependencies" ? "dependencies" : t === "system" ? "system" : "daemon",
        };
      }
      if (arg === "reviews") return parts[2] ? { screen: "reviews", id: parts[2] } : { screen: "reviews" };
      return { screen: "settings" };
    case "backlog":
      return arg ? { screen: "backlog", id: arg } : { screen: "backlog" };
    case "board":
      return arg ? { screen: "board", task: arg } : { screen: "board" };
    case "thread":
      return arg ? { screen: "thread", id: arg } : { screen: "inbox" };
    case "mrs":
    case "reviews":
      return arg ? { screen: "reviews", id: arg } : { screen: "reviews" };
    case "add":
      return { screen: "add" };
    case "app":
      return { screen: "app" };
    case "inbox": {
      // A decision's address has its repository, run and question as parts (`decisionKey`).
      const pick = parts.slice(1).join("/");
      return pick ? { screen: "inbox", pick } : { screen: "inbox" };
    }
    default:
      return { screen: "inbox" };
  }
}
export function routeHash(route: Route): string {
  switch (route.screen) {
    case "run": {
      const rest =
        route.tab === "terminal" && route.pane
          ? `/${encodeURIComponent(route.pane)}`
          : route.tab === "changes" && route.file
            ? `/${route.file.split("/").map(encodeURIComponent).join("/")}`
            : "";
      return `#/run/${encodeURIComponent(route.runId)}/${route.tab}${rest}`;
    }
    case "inbox":
      return `#/inbox${route.pick ? `/${route.pick.split("/").map(encodeURIComponent).join("/")}` : ""}`;
    case "reviews":
      return `#/reviews${route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
    case "board":
      return `#/board${route.task ? `/${encodeURIComponent(route.task)}` : ""}`;
    case "thread":
      return `#/thread/${encodeURIComponent(route.id)}`;
    case "backlog":
      return `#/backlog${route.id ? `/${encodeURIComponent(route.id)}` : ""}`;
    case "overview":
      return route.tab === "daemon" ? "#/settings/system" : `#/settings/system/${route.tab}`;
    case "grid":
      if (route.task)
        return `#/grid/task/${encodeURIComponent(route.task)}${route.session ? `/${encodeURIComponent(route.session)}` : ""}`;
      return route.pane
        ? `#/grid/pane:${encodeURIComponent(route.pane)}`
        : route.group
          ? `#/grid/${encodeURIComponent(route.group)}`
          : "#/grid";
    default:
      return `#/${route.screen}`;
  }
}
