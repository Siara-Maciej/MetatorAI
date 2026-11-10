import { defineConfig } from "vitepress";

/**
 * User documentation of MetatorAI, published to GitHub Pages by .github/workflows/pages.yml.
 * The base path comes from Pages (SITE_BASE); locally it defaults to the repository's path.
 *
 * The site is divided by what the reader is looking for: Start (begin), Concepts (understand),
 * Work (do), Knowledge (teach the agents your repository), Modules (extend), Reference (look up).
 * The top bar holds the six sections; each section has its own sidebar, and the Previous/Next
 * links at the bottom of a page follow that sidebar from its first page to its last.
 */

export const sections = [
  {
    text: "Start",
    base: "/start/",
    items: [
      { text: "Why MetatorAI", link: "why" },
      { text: "How it works", link: "how-it-works" },
      { text: "Installation", link: "installation" },
      { text: "Quick start", link: "quick-start" },
      { text: "Choose your path", link: "paths" },
      { text: "FAQ", link: "faq" },
    ],
  },
  {
    text: "Concepts",
    base: "/concepts/",
    items: [
      { text: "The seven concepts", link: "" },
      { text: "Run", link: "run" },
      { text: "Workflow", link: "workflow" },
      { text: "Gate and approvals", link: "gate" },
      { text: "Canon", link: "canon" },
      { text: "Finding", link: "finding" },
      { text: "Host", link: "host" },
      { text: "Session", link: "session" },
    ],
  },
  {
    text: "Work",
    base: "/work/",
    items: [
      { text: "Runs, in chat and in a terminal", link: "" },
      { text: "Inbox and decisions", link: "inbox" },
      { text: "Sessions and terminals", link: "sessions" },
      { text: "Terminals, panes and the conductor", link: "terminals" },
      { text: "The desktop app", link: "desktop" },
      { text: "The plan of a run", link: "plan" },
      { text: "The backlog", link: "backlog" },
      { text: "The change and your notes", link: "changes" },
      { text: "Ask about the code", link: "ask" },
      { text: "Feature (W1)", link: "feature" },
      { text: "Bug fix (W2)", link: "bugfix" },
      { text: "Refactor (W3)", link: "refactor" },
      { text: "Review (W4, W5)", link: "review" },
      { text: "System change (W13)", link: "system" },
      { text: "Autonomy and autopilot", link: "autonomy" },
    ],
  },
  {
    text: "Knowledge",
    base: "/knowledge/",
    items: [
      { text: "Write and enforce rules", link: "rules" },
      { text: "Keep knowledge true", link: "truth" },
      { text: "Agents and skills", link: "agents" },
      { text: "Skills", link: "skills" },
      { text: "Quality gates and CI", link: "gates-ci" },
      { text: "Hooks and guardrails", link: "hooks" },
    ],
  },
  {
    text: "Modules",
    base: "/modules/",
    items: [
      { text: "What a module is", link: "" },
      { text: "Several repositories", link: "repositories" },
      { text: "Systems of many applications", link: "systems" },
      { text: "Package architecture", link: "architecture" },
      { text: "Start the application", link: "environments" },
      { text: "Runs in worktrees", link: "worktrees" },
    ],
  },
  {
    text: "Reference",
    base: "/reference/",
    items: [
      { text: "Overview", link: "" },
      { text: "Commands for people", link: "commands-people" },
      { text: "Command reference", link: "commands" },
      { text: "CLI and envelope", link: "cli" },
      { text: "Hooks protocol", link: "hooks" },
      { text: "Documents and schemas", link: "documents" },
      { text: "Configuration", link: "configuration" },
      { text: "Extending: ports and plugins", link: "extending" },
      { text: "Security and governance", link: "security" },
      { text: "Troubleshooting", link: "troubleshooting" },
      { text: "Glossary", link: "glossary" },
      { text: "Changelog", link: "changelog" },
    ],
  },
] as const;

/** The absolute path of a sidebar entry: the section's base plus the entry's link. */
export const pathOf = (base: string, link: string) => (link === "" ? base : `${base}${link}`);

export default defineConfig({
  title: "MetatorAI",
  description:
    "Survey the codebase, lay out the rules, prove every claim, then ship. Documentation for users.",
  base: process.env.SITE_BASE ?? "/MetatorAI/",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,
  appearance: "dark",
  head: [["link", { rel: "icon", href: `${process.env.SITE_BASE ?? "/MetatorAI/"}logo.svg` }]],
  themeConfig: {
    logo: "/logo.svg",
    nav: sections.map((s) => ({ text: s.text, link: pathOf(s.base, s.items[0].link), activeMatch: s.base })),
    sidebar: Object.fromEntries(
      sections.map((s) => [
        s.base,
        [{ text: s.text, items: s.items.map((i) => ({ text: i.text, link: pathOf(s.base, i.link) })) }],
      ]),
    ),
    docFooter: { prev: "Previous", next: "Next" },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/Siara-Maciej/MetatorAI" }],
    editLink: {
      pattern: "https://github.com/Siara-Maciej/MetatorAI/edit/claude/foundation/site/:path",
      text: "Edit this page on GitHub",
    },
    outline: { level: [2, 3] },
    footer: {
      message: "Pre-alpha. Commands and file formats may still change between versions.",
      copyright: "MetatorAI",
    },
  },
});
