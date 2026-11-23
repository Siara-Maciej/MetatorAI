import { defineConfig } from "vitepress";

/**
 * User documentation of MetatorAI, published to GitHub Pages by .github/workflows/pages.yml.
 * The base path comes from Pages (SITE_BASE); locally it defaults to the repository's path.
 *
 * Five sections, by what the reader came for: Start (understand, install, and the two ways in: one
 * repository or many), Work (the app, day to day), Many repositories (a folder, systems, system
 * plans), Your repository (teach MetatorAI your repository) and Reference (look up). The top bar
 * holds the sections; each has its own sidebar, and Previous/Next at the bottom of a page follow it.
 */

export const sections = [
  {
    text: "Start",
    base: "/guide/",
    items: [
      { text: "What MetatorAI is", link: "" },
      { text: "Install", link: "install" },
      { text: "Get the desktop app", link: "desktop-app" },
      { text: "Dev Containers", link: "devcontainers" },
      { text: "Start with one repository", link: "first-run" },
      { text: "Start with many repositories", link: "many" },
      { text: "Java repositories", link: "java" },
      { text: "Copilot and Claude Code", link: "hosts" },
      { text: "Host conformance", link: "conformance" },
      { text: "FAQ", link: "faq" },
    ],
  },
  {
    text: "Work",
    base: "/use/",
    items: [
      { text: "The app", link: "" },
      { text: "Chats and the three ways", link: "start" },
      { text: "Quick and debug changes", link: "quick" },
      { text: "Full runs", link: "runs" },
      { text: "Home and the Board", link: "inbox" },
      { text: "Approvals and consent", link: "approvals" },
      { text: "Terminals and sessions", link: "sessions" },
      { text: "Plan and backlog", link: "plan" },
      { text: "Read the change", link: "changes" },
      { text: "Reviews", link: "reviews" },
      { text: "Ask about the code", link: "ask" },
      { text: "Your settings", link: "settings" },
      { text: "Feature", link: "feature" },
      { text: "Bug fix", link: "bugfix" },
      { text: "Refactor", link: "refactor" },
      { text: "Review a change", link: "review" },
    ],
  },
  {
    text: "Many repositories",
    base: "/many/",
    items: [
      { text: "Folder of repositories", link: "" },
      { text: "Systems of applications", link: "systems" },
      { text: "System plans", link: "plans" },
    ],
  },
  {
    text: "Your repository",
    base: "/repo/",
    items: [
      { text: "Rules", link: "" },
      { text: "Keep knowledge true", link: "knowledge" },
      { text: "Agents and skills", link: "agents" },
      { text: "Hooks and guardrails", link: "hooks" },
      { text: "Gates and CI", link: "gates-ci" },
      { text: "Package architecture", link: "architecture" },
      { text: "Run the application", link: "environments" },
      { text: "Automatic intake", link: "intake" },
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
      { text: "Daemon HTTP API", link: "http" },
      { text: "MCP server", link: "mcp" },
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
    "A desktop app and a workflow for AI coding agents on Claude Code and GitHub Copilot CLI, for one repository or many.",
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
