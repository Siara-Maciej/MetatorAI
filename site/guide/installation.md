# Installation

MetatorAI works in repositories that use **npm, pnpm, Yarn or Bun**. It detects your package manager (`metator discover`) and runs your own `lint`, `typecheck` and `test` scripts with it. Pick yours here, in the navigation bar, or on any tab below: every command in the documentation follows it.

<PmSwitch />

MetatorAI itself is pre-alpha and not published to npm yet. You run it from a checkout of its repository, and it needs the [Bun](https://bun.sh) runtime whatever package manager your project uses.

## Requirements

| Tool | Why |
|---|---|
| [Bun](https://bun.sh) 1.4 or newer | the MetatorAI CLI runs on Bun (your project does not have to) |
| git | changed files, merge bases, history, worktrees |
| Your project's package manager: npm, pnpm, Yarn or Bun | MetatorAI runs your scripts with it |
| Optional: `@ast-grep/cli`, `@biomejs/biome`, `typescript` in your project | rule engines for tool-enforced (E1) rules |

## 1. Install Bun

::: code-group

```bash [npm]
npm install --global bun
```

```bash [pnpm]
pnpm add --global bun
```

```bash [yarn]
npm install --global bun     # Yarn 2+ has no global installs; Yarn 1: yarn global add bun
```

```bash [bun]
curl -fsSL https://bun.sh/install | bash     # Bun's own installer; skip if `bun --version` works
```

:::

Check it with `bun --version` (1.4 or newer).

## 2. Install MetatorAI

```bash
git clone https://github.com/Siara-Maciej/MetatorAI.git ~/tools/metatorai
cd ~/tools/metatorai
bun install
cd packages/cli && bun link        # puts `metator` into ~/.bun/bin
```

These steps are the same for every package manager: they build MetatorAI itself, which runs on Bun. Make sure `~/.bun/bin` is on your `PATH`, then check from any repository:

```bash
cd ~/code/your-repo
metator version
# {"ok":true,"data":{"name":"metator-ai","version":"0.0.0"}}
```

**Why `bun link`:** hooks and generated agents call plain `metator ...`. With the command on your `PATH` they work in every repository, whatever its package manager, without per-repo setup. That is also why `metator` commands in these docs have no package-manager tabs: they are the same everywhere.

### Without `bun link`

Run the entry file directly and tell the generated agents how to call it:

```bash
alias metator="bun ~/tools/metatorai/packages/cli/src/main.ts"
```

```yaml
# metator.config.yml
hosts:
  metatorCommand: bun ~/tools/metatorai/packages/cli/src/main.ts
```

## 3. Rule engines in your project

Tool-enforced rules run the engines installed in **your** repository, as dev dependencies:

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

`@ast-grep/cli` downloads its binary in an install script. Make sure your package manager runs it:

::: code-group

```text [npm]
Nothing to do: npm runs install scripts of dependencies by default
(unless you set ignore-scripts=true in .npmrc).
```

```jsonc [pnpm]
// package.json: pnpm 10 runs no dependency install scripts unless listed
// (or approve them with `pnpm approve-builds`), then run `pnpm install`
{ "pnpm": { "onlyBuiltDependencies": ["@ast-grep/cli"] } }
```

```text [yarn]
Nothing to do: Yarn runs install scripts by default
(unless enableScripts: false is set in .yarnrc.yml).
```

```jsonc [bun]
// package.json: Bun runs no dependency install scripts unless trusted,
// then run `bun install`
{ "trustedDependencies": ["@ast-grep/cli"] }
```

:::

Without the binary, `metator rules check` answers `BIN_NOT_FOUND`.

::: tip Several repositories
Run `metator setup` inside each repository you want MetatorAI in; each one is independent. To see the work of all of them from the folder that holds them, see [Several repositories](../multi-repo/repositories.md).
:::

## Update

```bash
cd ~/tools/metatorai && git pull && bun install
```

Files MetatorAI wrote with an older version are migrated when they are read, so no manual migration is needed.

## Next

Continue with the [Quick start](./quick-start.md).
