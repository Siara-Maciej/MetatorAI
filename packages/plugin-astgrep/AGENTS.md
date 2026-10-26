# @metator/plugin-astgrep

`RuleEngine` and `RuleScaffolder` on the ast-grep CLI.

- Rules and their tests live in `rules/` (`sgconfig.yml`); `bun run arch` runs `ast-grep test` and `ast-grep scan`.
- Pitfall: A YAML pattern with a colon or braces needs quotes, or ast-grep reads a different rule.
