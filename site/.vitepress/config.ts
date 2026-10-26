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
  head: [["link", { rel: "icon", href: `${process.env.SITE_BASE ?? "/MetatorAI/"}logo.svg` }]],
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/guide/introduction", activeMatch: "/guide/" },
      { text: "Workflows", link: "/workflows/", activeMatch: "/workflows/" },
      { text: "How-to", link: "/how-to/rules", activeMatch: "/how-to/" },
      { text: "Reference", link: "/reference/cli", activeMatch: "/reference/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Getting started",
          items: [
            { text: "Introduction", link: "/guide/introduction" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Quick start", link: "/guide/quick-start" },
          ],
        },
        {
          text: "Understand",
          items: [
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
      "/how-to/": [
        {
          text: "How-to guides",
          items: [
            { text: "Write and enforce rules", link: "/how-to/rules" },
            { text: "Keep knowledge true", link: "/how-to/knowledge" },
            { text: "Quality gates and CI", link: "/how-to/gates-ci" },
            { text: "Hooks and guardrails", link: "/how-to/hooks" },
            { text: "Agents and skills", link: "/how-to/agents" },
            { text: "Systems of many applications", link: "/how-to/system" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "CLI", link: "/reference/cli" },
            { text: "Output and exit codes", link: "/reference/output" },
            { text: "Files and documents", link: "/reference/documents" },
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
