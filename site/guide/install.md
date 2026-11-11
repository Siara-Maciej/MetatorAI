# Install

This page puts the `metator` command on your machine. MetatorAI works in repositories that use npm, pnpm, Yarn or Bun, and it runs your `lint`, `typecheck` and `test` scripts with the package manager it detects. Pick yours once and every tabbed command on this site follows it.

<PmSwitch />

MetatorAI is pre-alpha and is not published to npm. You install it from a checkout of its repository.

## Requirements

| Tool | Why |
|---|---|
| [Bun](https://bun.sh) 1.4 or newer | the `metator` CLI runs on Bun, whatever your project uses |
| git | changed files, history, worktrees |
| GitHub Copilot or Claude Code | the AI tool that runs the agents |

## Install Bun

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

`bun --version` must print 1.4 or newer.

## Install MetatorAI

```bash
git clone https://github.com/Siara-Maciej/MetatorAI.git ~/tools/metatorai
cd ~/tools/metatorai
bun install
cd packages/cli && bun link
```

`bun link` puts `metator` into `~/.bun/bin`. Make sure that directory is on your `PATH`, then check from any directory:

```bash
metator version
```

```json
{"ok":true,"data":{"name":"metator-ai","version":"0.0.0"}}
```

The command has to be on your `PATH` because the hooks and the generated agents call plain `metator`.

### Without `bun link`

Define an alias for yourself:

```bash
alias metator="bun ~/tools/metatorai/packages/cli/src/main.ts"
```

Then, after you [set up the repository](./first-run.md), tell the generated agents and hooks how to call the CLI and run `metator generate --hooks`:

```yaml
# metator.config.yml
hosts:
  metatorCommand: bun ~/tools/metatorai/packages/cli/src/main.ts
```

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

```bash
cd ~/tools/metatorai && git pull && bun install
```

Files written by an older version are migrated when they are read. To take the newer agents, skills and workflows into a repository you already set up, run `metator agents update` there (see [First run](./first-run.md#update-the-shipped-files)).

Next: [First run](./first-run.md).
