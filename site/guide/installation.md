# Installation

MetatorAI is pre-alpha and not published to npm yet. You run it from a checkout of its repository; `bun link` puts the `metator` command on your `PATH`.

## Requirements

| Tool | Why |
|---|---|
| [Bun](https://bun.sh) 1.4 or newer | MetatorAI runs on Bun |
| git | changed files, merge bases, history |
| Your project's own tools | MetatorAI runs your lint, typecheck and test scripts; it does not replace them |
| Optional: `@ast-grep/cli`, `@biomejs/biome`, `typescript` in your project | rule engines for tool-enforced (E1) rules |

## Install

```bash
git clone https://github.com/Siara-Maciej/MetatorAI.git ~/tools/metatorai
cd ~/tools/metatorai
bun install
cd packages/cli && bun link        # puts `metator` into ~/.bun/bin
```

Make sure `~/.bun/bin` is on your `PATH`, then check from any repository:

```bash
cd ~/code/your-repo
metator version
# {"ok":true,"data":{"name":"metator-ai","version":"0.0.0"}}
```

**Why `bun link`:** hooks and generated agents call plain `metator ...`. With the command on your `PATH` they work in every repository without per-repo setup.

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

## Rule engines in your project

Tool-enforced rules run the engines installed in **your** repository:

```bash
bun add -d @ast-grep/cli          # structural rules
bun add -d @biomejs/biome         # lint rules through SARIF
```

::: warning Bun and ast-grep
Bun blocks package install scripts by default, and `@ast-grep/cli` needs its install script to download the binary. Add it to `trustedDependencies` in your `package.json`, then reinstall:

```json
{ "trustedDependencies": ["@ast-grep/cli"] }
```

Without it, `metator rules check` answers `BIN_NOT_FOUND`.
:::

## Update

```bash
cd ~/tools/metatorai && git pull && bun install
```

Files MetatorAI wrote with an older version are migrated when they are read, so no manual migration is needed.

## Next

Continue with the [Quick start](./quick-start.md).
