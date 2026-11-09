/**
 * Builds the npm package `metator-ai` (F8.8, ADR-0049): the CLI bundled with `bun build`, the
 * canon beside it (agents, skills, workflow specs, rules, patterns, schemas), and a manifest with
 * the dependencies the bundle leaves native or optional. Publishing is the owner's step; this
 * script makes the directory `npm publish` would take, and the e2e runs the result.
 *
 * Usage: bun scripts/pack.ts [--out dist/metator-ai]
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import root from "../package.json" with { type: "json" };
import cli from "../packages/cli/package.json" with { type: "json" };
import claude from "../packages/plugin-host-claude/package.json" with { type: "json" };
import node from "../packages/plugin-node/package.json" with { type: "json" };

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const OUT = resolve(ROOT, outArg >= 0 ? (args[outArg + 1] as string) : "dist/metator-ai");

/** What the runtime reads from its own installation (`resolveCanon`), copied as is. */
export const SHIPPED_DIRS = [
  "metator",
  ".github/metator/workflows",
  "docs/metator/rules",
  "docs/metator/patterns",
  "docs/metator/schemas",
] as const;

/** Packages the bundle does not inline: native code, or a host SDK that is optional. */
export const EXTERNALS = ["node-pty", "@anthropic-ai/claude-agent-sdk", "react-devtools-core"] as const;

const dep = (
  manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
  name: string,
) => manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];

export function packageManifest(): Record<string, unknown> {
  return {
    name: "metator-ai",
    version: cli.version,
    description:
      "MetatorAI: host-agnostic agentic engineering workflow for GitHub Copilot and Claude Code. Survey first, prove everything.",
    type: "module",
    bin: { metator: "bin/metator.js" },
    files: ["bin", ...SHIPPED_DIRS, "README.md"],
    engines: { bun: ">=1.4.0" },
    dependencies: {
      "node-pty": dep(node, "node-pty"),
      "@ast-grep/cli": dep(root, "@ast-grep/cli"),
      "@biomejs/biome": dep(root, "@biomejs/biome"),
    },
    optionalDependencies: { "@anthropic-ai/claude-agent-sdk": dep(claude, "@anthropic-ai/claude-agent-sdk") },
    trustedDependencies: ["node-pty", "@ast-grep/cli"],
    repository: { type: "git", url: "https://github.com/Siara-Maciej/MetatorAI.git" },
    keywords: ["ai", "agents", "copilot", "claude-code", "workflow", "code-review", "architecture"],
  };
}

export async function pack(
  out = OUT,
): Promise<{ readonly out: string; readonly bundle: string; readonly bytes: number }> {
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "bin"), { recursive: true });
  const built = await Bun.build({
    entrypoints: [join(ROOT, "packages/cli/src/main.ts")],
    outdir: join(out, "bin"),
    target: "bun",
    naming: { entry: "metator.js", asset: "[name]-[hash].[ext]" },
    external: [...EXTERNALS],
  });
  if (!built.success) throw new Error(built.logs.map((l) => l.message).join("\n"));
  for (const dir of SHIPPED_DIRS) await cp(join(ROOT, dir), join(out, dir), { recursive: true });
  await cp(join(ROOT, "README.md"), join(out, "README.md"));
  await writeFile(join(out, "package.json"), `${JSON.stringify(packageManifest(), null, 2)}\n`);
  const bundle = join(out, "bin/metator.js");
  return { out, bundle, bytes: Bun.file(bundle).size };
}

if (import.meta.main) {
  const r = await pack();
  console.log(`packed ${r.out} (${(r.bytes / 1_000_000).toFixed(1)} MB bundle)`);
}
