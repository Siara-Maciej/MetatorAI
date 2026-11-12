import { defineConfig } from "vitepress";

/**
 * User documentation of MetatorAI, published to GitHub Pages by .github/workflows/pages.yml.
 * The base path comes from Pages (SITE_BASE); locally it defaults to the repository's path.
 *
 * Four sections, by what the reader came for: Guide (understand and install), App (do the work),
 * Repository (teach MetatorAI your repository), Reference (look up). The top bar holds the
 * sections; each has its own sidebar, and Previous/Next at the bottom of a page follow it.
 */

export const sections = [
  {
    text: "Guide",
    base: "/guide/",
    items: [
      { text: "What MetatorAI is", link: "" },
      { text: "Install", link: "install" },
      { text: "First run", link: "first-run" },
      { text: "Runs and workflows", link: "runs" },
      { text: "Gates and approvals", link: "gates" },
      { text: "Copilot and Claude Code", link: "hosts" },
      { text: "FAQ", link: "faq" },
    ],
  },
  {
    text: "App",
    base: "/use/",
    items: [
      { text: "The app", link: "" },
      { text: "Start a task", link: "start" },
      { text: "Answer questions", link: "inbox" },
      { text: "Sessions and worktrees", link: "sessions" },
      { text: "Workbench and terminals", link: "desktop" },
      { text: "Plan and backlog", link: "plan" },
      { text: "Read the change", link: "changes" },
      { text: "Answer a review", link: "reviews" },
      { text: "Automatic intake", link: "intake" },
      { text: "Ask about the code", link: "ask" },
      { text: "Your settings", link: "settings" },
      { text: "Feature", link: "feature" },
      { text: "Bug fix", link: "bugfix" },
      { text: "Refactor", link: "refactor" },
      { text: "Review a change", link: "review" },
      { text: "Change across applications", link: "system" },
    ],
  },
  {
    text: "Repository",
    base: "/repo/",
    items: [
      { text: "Rules", link: "" },
      { text: "Keep knowledge true", link: "knowledge" },
      { text: "Agents and skills", link: "agents" },
      { text: "Gates and CI", link: "gates-ci" },
      { text: "Hooks and guardrails", link: "hooks" },
      { text: "Package architecture", link: "architecture" },
      { text: "Several repositories", link: "repositories" },
      { text: "Systems of applications", link: "systems" },
      { text: "Run the application", link: "environments" },
    ],
  },
  {
    text: "Reference",
    base: "/reference/",
    items: [
      { text: "Reference", link: "" },
      { text: "Command reference", link: "commands" },
      { text: "Output and exit codes", link: "cli" },
      { text: "Configuration", link: "configuration" },
      { text: "Documents and schemas", link: "documents" },
      { text: "Hooks protocol", link: "hooks" },
      { text: "Ports and plugins", link: "extending" },
      { text: "Security", link: "security" },
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
    "A workflow for AI coding agents: plans, gates and approvals around GitHub Copilot and Claude Code.",
  base: process.env.SITE_BASE ?? "/MetatorAI/",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,
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
      pattern: "https://github.com/Siara-Maciej/MetatorAI/edit/main/site/:path",
      text: "Edit this page on GitHub",
    },
    outline: { level: [2, 3] },
  },
});
