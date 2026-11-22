/**
 * A stand-in for GitHub's `gh` CLI, so no test ever reaches github.com: the commands the gh
 * review adapter runs, answered from the JSON file FAKE_GH_STATE (the same shape as the fake MCP
 * server's FAKE_MCP_PULLS: `{ pulls, threads, diffs, requested }`); what changes the host is
 * appended to FAKE_GH_LOG, one JSON line each, and written back to the file.
 * `writeGhShim(dir)` puts an executable `gh` in `dir` that runs this script, for a test's PATH.
 */
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Comment {
  id: number;
  body: string;
  path?: string;
  line?: number;
  author?: { login: string };
}
interface Pull {
  number: number;
  title: string;
  html_url?: string;
  user?: { login: string };
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
  state?: string;
  merged?: boolean;
  commits?: string[];
}
interface State {
  pulls: Pull[];
  threads: Record<string, { id: string; isResolved?: boolean; comments: Comment[] }[]>;
  diffs?: Record<string, string>;
  requested?: number[];
}

/** An executable `gh` in `dir` that runs this stand-in; put `dir` first on PATH. */
export function writeGhShim(dir: string): string {
  const shim = join(dir, "gh");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${import.meta.path}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

function main(args: string[]): number {
  /** Prints the answer; gh exits 0. */
  const say = (value: unknown): number => {
    process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
    return 0;
  };
  /** Prints why on stderr; gh exits 1. */
  const fail = (why: string): number => {
    process.stderr.write(why);
    return 1;
  };
  if (args[0] === "--version") return say("gh version 0.0.0 (metator stand-in)\n");
  if (args[0] === "auth" && args[1] === "status")
    return process.env.FAKE_GH_LOGGED_OUT === "1" ? fail("not logged in\n") : 0;
  const file = process.env.FAKE_GH_STATE ?? "";
  const state = JSON.parse(readFileSync(file, "utf8")) as State;
  const save = () => writeFileSync(file, JSON.stringify(state));
  const log = (entry: object) =>
    appendFileSync(process.env.FAKE_GH_LOG ?? "/dev/null", `${JSON.stringify({ gh: true, ...entry })}\n`);
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const numberOf = (ref: string) => Number(/(\d+)\/?$/.exec(ref)?.[1] ?? ref);
  const repo = flag("-R") ?? "";
  // A repository that does not exist (the contract's `missing` source).
  if (repo === "acme/missing" || args.some((a) => a.includes("acme/missing") || a === "name=missing")) {
    return fail("GraphQL: Could not resolve to a Repository\n");
  }
  const short = (p: Pull) => ({
    number: p.number,
    title: p.title,
    headRefName: p.head?.ref ?? "",
    url: p.html_url ?? "",
    author: { login: p.user?.login ?? "" },
  });
  if (args[0] === "pr" && args[1] === "list") {
    const asked = (flag("--search") ?? "").includes("review-requested:@me");
    const open = state.pulls.filter((p) => (p.state ?? "open") === "open");
    return say(open.filter((p) => !asked || (state.requested ?? []).includes(p.number)).map(short));
  }
  if (args[0] === "pr" && args[1] === "view") {
    const p = state.pulls.find((x) => x.number === numberOf(args[2] ?? ""));
    if (!p) return fail("no pull requests found\n");
    return say({
      ...short(p),
      baseRefName: p.base?.ref ?? "main",
      headRefOid: p.head?.sha ?? "",
      state: p.merged ? "MERGED" : (p.state ?? "open").toUpperCase(),
      commits: (p.commits ?? [p.head?.sha ?? ""]).map((oid) => ({ oid })),
    });
  }
  if (args[0] === "pr" && args[1] === "diff")
    return say(state.diffs?.[String(numberOf(args[2] ?? ""))] ?? "");
  if (args[0] === "pr" && args[1] === "review") {
    log({ approve: Number(args[2]), ...(flag("--body") ? { body: flag("--body") } : {}) });
    return 0;
  }
  if (args[0] === "api" && args[1] === "graphql") {
    const fields = Object.fromEntries(
      args.flatMap((a, i) =>
        args[i - 1] === "-f" || args[i - 1] === "-F" ? [a.split(/=(.*)/s).slice(0, 2)] : [],
      ),
    ) as Record<string, string>;
    if ((fields.query ?? "").includes("resolveReviewThread")) {
      if (!Object.values(state.threads).some((list) => list.some((t) => t.id === fields.id)))
        return fail(`GraphQL: Could not resolve to a node with the global id of '${fields.id}'\n`);
      for (const list of Object.values(state.threads))
        for (const t of list) if (t.id === fields.id) t.isResolved = true;
      save();
      log({ resolve: fields.id });
      return say({ data: { resolveReviewThread: { thread: { id: fields.id } } } });
    }
    const nodes = (state.threads[String(fields.number)] ?? []).map((t) => ({
      id: t.id,
      isResolved: t.isResolved === true,
      comments: {
        nodes: t.comments.map((c) => ({
          databaseId: c.id,
          body: c.body,
          path: c.path ?? null,
          line: c.line ?? null,
          author: c.author ?? { login: "someone" },
        })),
      },
    }));
    return say({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
  }
  if (args[0] === "api" && args.includes("POST")) {
    const path = args.find((a) => a.startsWith("repos/")) ?? "";
    const pairs = args.flatMap((a, i) =>
      args[i - 1] === "-f" || args[i - 1] === "-F" ? [a.split(/=(.*)/s)] : [],
    );
    const pull = /pulls\/(\d+)/.exec(path)?.[1] ?? "0";
    const reply = /comments\/(\d+)\/replies$/.exec(path);
    if (reply) {
      const body = pairs.find(([k]) => k === "body")?.[1] ?? "";
      for (const t of state.threads[pull] ?? [])
        if (t.comments.some((c) => String(c.id) === reply[1]))
          t.comments.push({ id: 9000 + t.comments.length, body, author: { login: "metator-bot" } });
      save();
      log({ reply: Number(reply[1]), pull: Number(pull), body });
      return say({ id: 9999 });
    }
    if (path.endsWith("/reviews")) {
      const comments: Comment[] = [];
      let body = "";
      for (const [k, v = ""] of pairs) {
        if (k === "body") body = v;
        else if (k === "comments[][path]")
          comments.push({ id: 0, body: "", path: v, author: { login: "metator-bot" } });
        else if (k === "comments[][line]" && comments.length > 0)
          (comments.at(-1) as Comment).line = Number(v);
        else if (k === "comments[][body]" && comments.length > 0) (comments.at(-1) as Comment).body = v;
      }
      const taken = Object.values(state.threads).flat().length;
      comments.forEach((c, i) => {
        c.id = 8000 + taken + i;
      });
      state.threads[pull] = [
        ...(state.threads[pull] ?? []),
        ...comments.map((c) => ({ id: `GT${c.id}`, isResolved: false, comments: [c] })),
      ];
      save();
      log({
        review: Number(pull),
        body,
        comments: comments.map((c) => ({ path: c.path, line: c.line, body: c.body })),
      });
      return say({ id: 5555 });
    }
  }
  process.stderr.write(`fake gh: not known: ${args.join(" ")}\n`);
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
