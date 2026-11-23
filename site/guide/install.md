# Install

MetatorAI is one desktop app, and the `metator` command is inside it. Install the app, then **Add repository** in it: that is all. MetatorAI works in repositories that use npm, pnpm, Yarn or Bun, and it runs your `lint`, `typecheck` and `test` scripts with the package manager it detects. Pick yours once and every tabbed command on this site follows it.

<PmSwitch />

## Requirements

| Tool | Why |
|---|---|
| [The desktop app](./desktop-app.md) | MetatorAI itself: the window, the `metator` command, the daemon |
| [git](https://git-scm.com/downloads) | changed files, history, worktrees |
| Claude Code (`claude`) or GitHub Copilot CLI (`copilot`), installed and logged in | the AI tool that runs the agents. The daemon starts the command-line program in a terminal; Copilot Chat inside an IDE does not run a chat of the app |

The app cannot install git or the AI tool for you. When you add a repository it checks both, and for one that is missing it shows how to install it, with a link and **Retry**:

| Tool | Install | Log in |
|---|---|---|
| git | [git-scm.com/downloads](https://git-scm.com/downloads) | |
| Claude Code | `npm install -g @anthropic-ai/claude-code`, or [code.claude.com/docs/en/setup](https://code.claude.com/docs/en/setup) | run `claude` in a terminal, then type `/login` |
| GitHub Copilot CLI | `npm install -g @github/copilot`, or [the Copilot CLI docs](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) | run `copilot` in a terminal, then type `/login` |

You do not need Bun or Node.js for MetatorAI itself.

## Install the app

Download the installer for Windows, macOS or Linux: [Get the desktop app](./desktop-app.md). Open it and click **Add repository**; [Start with one repository](./first-run.md) goes on from there.

## The `metator` command in your terminal

Everything the app starts finds `metator` by itself: the daemon, the agents' sessions and the hooks in them. You need the command in your own terminal only to run `metator` yourself, or for a `claude` or `copilot` you start by hand outside the app.

In the app, open **Settings**, then **Install the metator command**. The app writes a small launcher and says where:

| Platform | Launcher |
|---|---|
| Linux, macOS | `~/.local/bin/metator` |
| Windows | `%LOCALAPPDATA%\MetatorAI\bin\metator.cmd`, a folder the app adds to your user `PATH` |

When `~/.local/bin` is not on your `PATH`, the app says so; add it in your shell profile (`~/.bashrc`, `~/.zshrc`):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then, in a new terminal:

```bash
metator version
```

```json
{"ok":true,"data":{"name":"metator-ai","version":"0.0.0"}}
```

**Remove it** in the same place deletes the launcher again. The app only ever writes or removes its own launcher: a `metator` you installed yourself stays where it is. The `.AppImage` cannot install the command, because its files move each time it starts; use the `.deb` for it.

## From a checkout (for developers of MetatorAI)

To run MetatorAI from its sources you need [Bun](https://bun.sh) 1.4 or newer:

::: code-group

```bash [npm]
npm install --global bun
```

```bash [pnpm]
pnpm add --global bun
```

```bash [yarn]
npm install --global bun     # Yarn 2+ has no global installs
```

```bash [bun]
curl -fsSL https://bun.sh/install | bash     # skip if `bun --version` works
```

:::

`bun --version` must print 1.4 or newer. Then:

```bash
git clone https://github.com/Siara-Maciej/MetatorAI.git ~/tools/metatorai
cd ~/tools/metatorai
bun install
cd packages/cli && bun link
```

`bun link` links `metator` into Bun's global bin folder; it does not change your `PATH`. `bun pm bin -g` prints where that folder is; put it on your `PATH` in your shell profile if `metator` is not found:

```bash
export PATH="$(bun pm bin -g):$PATH"
```

Then tell the app to use it: **Settings**, **Where it comes from**, **The metator on your PATH** (or **A metator you chose**, with the path of a program). The app uses the `metator` it ships with (**Bundled with the app**) until you choose another.

## Rule engines in your project

This step is optional. Rules that a tool enforces run the engines installed in your repository. Add them when you start writing [rules](../repo/index.md):

::: code-group

```bash [npm]
npm install --save-dev @ast-grep/cli @biomejs/biome
```

```bash [pnpm]
pnpm add --save-dev @ast-grep/cli @biomejs/biome
```

```bash [yarn]
yarn add --dev @ast-grep/cli @biomejs/biome
```

```bash [bun]
bun add --dev @ast-grep/cli @biomejs/biome
```

:::

`@ast-grep/cli` downloads its binary in an install script. npm and Yarn run install scripts by default. pnpm and Bun need the package listed first:

::: code-group

```text [npm]
Nothing to do, unless ignore-scripts=true is set in .npmrc.
```

```jsonc [pnpm]
// package.json, then run `pnpm install`
{ "pnpm": { "onlyBuiltDependencies": ["@ast-grep/cli"] } }
```

```text [yarn]
Nothing to do, unless enableScripts: false is set in .yarnrc.yml.
```

```jsonc [bun]
// package.json, then run `bun install`
{ "trustedDependencies": ["@ast-grep/cli"] }
```

:::

Without the binary, `metator rules check` fails with the error code `BIN_NOT_FOUND`.

## Update

Install the newer app over the old one: the app and its `metator` have one version. When a repository was set up by a newer MetatorAI than the app's, the app says so and asks you to update the app; it never writes older files over newer ones.

From a checkout: `cd ~/tools/metatorai && git pull && bun install`.

Files written by an older version are migrated when they are read. To take the newer agents, skills and workflows into a repository you already set up, run `metator agents update` there (see [Start with one repository](./first-run.md#update-the-shipped-files)).

Next: [Get the desktop app](./desktop-app.md), then [Start with one repository](./first-run.md) or [Start with many repositories](./many.md).
