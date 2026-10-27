import { defineConfig } from "vitepress";

/**
 * User documentation of MetatorAI, published to GitHub Pages by .github/workflows/pages.yml.
 * The base path comes from Pages (SITE_BASE); locally it defaults to the repository's path.
 */
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
    // No links in the top bar: the sidebar is the table of contents, one chapter after another,
    // and the Previous/Next links at the bottom of each page follow it from the first to the last.
    nav: [],
    sidebar: [
      {
        text: "Get started",
        collapsed: false,
        items: [
          { text: "The idea", link: "/product/idea" },
          { text: "How it works", link: "/product/how-it-works" },
          { text: "Installation", link: "/guide/installation" },
          { text: "Quick start", link: "/guide/quick-start" },
        ],
      },
      {
        text: "Concepts",
        collapsed: true,
        items: [
          { text: "Concepts", link: "/guide/concepts" },
          { text: "Configuration", link: "/guide/configuration" },
        ],
      },
      {
        text: "Workflows",
        collapsed: true,
        items: [
          { text: "Overview and runs", link: "/workflows/" },
          { text: "Drive a run from the CLI", link: "/workflows/drive" },
          { text: "Feature (W1)", link: "/workflows/feature" },
          { text: "Bug fix (W2)", link: "/workflows/bugfix" },
          { text: "Refactor (W3)", link: "/workflows/refactor" },
          { text: "Review (W4, W5)", link: "/workflows/review" },
        ],
      },
      {
        text: "Agents and skills",
        collapsed: true,
        items: [
          { text: "Agents and delegation", link: "/agents/" },
          { text: "Skills", link: "/agents/skills" },
          { text: "Customize and add agents", link: "/agents/customize" },
        ],
      },
      {
        text: "Guides",
        collapsed: true,
        items: [
          { text: "Write and enforce rules", link: "/how-to/rules" },
          { text: "Keep knowledge true", link: "/how-to/knowledge" },
          { text: "Quality gates and CI", link: "/how-to/gates-ci" },
          { text: "Hooks and guardrails", link: "/how-to/hooks" },
          { text: "Runs in worktrees", link: "/how-to/worktrees" },
          { text: "Start the application", link: "/how-to/environments" },
        ],
      },
      {
        text: "Many applications",
        collapsed: true,
        items: [{ text: "Systems of many applications", link: "/multi-repo/" }],
      },
      {
        text: "Enterprise",
        collapsed: true,
        items: [{ text: "Security and governance", link: "/product/enterprise" }],
      },
      {
        text: "API reference",
        collapsed: true,
        items: [
          { text: "Overview", link: "/api/" },
          { text: "CLI and envelope", link: "/api/cli" },
          { text: "Hooks protocol", link: "/api/hooks" },
          { text: "Documents and schemas", link: "/api/documents" },
          { text: "Extending: ports and plugins", link: "/api/extending" },
          { text: "Command reference", link: "/api/commands" },
        ],
      },
      {
        text: "Help",
        collapsed: true,
        items: [{ text: "Troubleshooting", link: "/guide/troubleshooting" }],
      },
    ],
    docFooter: { prev: "Previous chapter", next: "Next chapter" },
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
