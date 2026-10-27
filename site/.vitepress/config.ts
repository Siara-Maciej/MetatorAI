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
    nav: [
      {
        text: "Product",
        activeMatch: "/product/",
        items: [
          { text: "The idea", link: "/product/idea" },
          { text: "How it works", link: "/product/how-it-works" },
          { text: "Security and governance", link: "/product/enterprise" },
        ],
      },
      { text: "First steps", link: "/guide/installation", activeMatch: "/guide/" },
      { text: "Workflows", link: "/workflows/", activeMatch: "/workflows/" },
      { text: "Agents", link: "/agents/", activeMatch: "/agents/" },
      { text: "Multi-repo", link: "/multi-repo/", activeMatch: "/multi-repo/" },
      { text: "How-to", link: "/how-to/rules", activeMatch: "/how-to/" },
      { text: "API", link: "/api/", activeMatch: "/api/" },
    ],
    sidebar: {
      "/product/": [
        {
          text: "Product",
          items: [
            { text: "The idea", link: "/product/idea" },
            { text: "How it works", link: "/product/how-it-works" },
            { text: "Security and governance", link: "/product/enterprise" },
          ],
        },
        { text: "Next", items: [{ text: "First steps →", link: "/guide/installation" }] },
      ],
      "/guide/": [
        {
          text: "First steps",
          items: [
            { text: "Installation", link: "/guide/installation" },
            { text: "Quick start", link: "/guide/quick-start" },
            { text: "Concepts", link: "/guide/concepts" },
            { text: "Configuration", link: "/guide/configuration" },
            { text: "Troubleshooting", link: "/guide/troubleshooting" },
          ],
        },
      ],
      "/workflows/": [
        {
          text: "Workflows",
          items: [
            { text: "Overview and runs", link: "/workflows/" },
            { text: "Feature (W1)", link: "/workflows/feature" },
            { text: "Bug fix (W2)", link: "/workflows/bugfix" },
            { text: "Refactor (W3)", link: "/workflows/refactor" },
            { text: "Review (W4, W5)", link: "/workflows/review" },
          ],
        },
      ],
      "/agents/": [
        {
          text: "Agents",
          items: [
            { text: "Agents and delegation", link: "/agents/" },
            { text: "Skills", link: "/agents/skills" },
            { text: "Customize and add agents", link: "/agents/customize" },
          ],
        },
      ],
      "/multi-repo/": [
        {
          text: "Multi-repo",
          items: [{ text: "Systems of many applications", link: "/multi-repo/" }],
        },
      ],
      "/how-to/": [
        {
          text: "How-to guides",
          items: [
            { text: "Write and enforce rules", link: "/how-to/rules" },
            { text: "Keep knowledge true", link: "/how-to/knowledge" },
            { text: "Quality gates and CI", link: "/how-to/gates-ci" },
            { text: "Hooks and guardrails", link: "/how-to/hooks" },
          ],
        },
      ],
      "/api/": [
        {
          text: "API",
          items: [
            { text: "Overview", link: "/api/" },
            { text: "CLI and envelope", link: "/api/cli" },
            { text: "Hooks protocol", link: "/api/hooks" },
            { text: "Documents and schemas", link: "/api/documents" },
            { text: "Extending: ports and plugins", link: "/api/extending" },
            { text: "Command reference", link: "/api/commands" },
          ],
        },
      ],
    },
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
