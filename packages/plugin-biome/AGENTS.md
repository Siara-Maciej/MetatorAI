# @metator/plugin-biome

`RuleEngine` on Biome, read through its SARIF reporter.

- A canon rule binds to `biome:lint/<group>/<rule>`; the engine checks that the rule is enabled in `biome.json`.
- Pitfall: Biome versions rename rules: pin the version and rerun `rules check` after an upgrade.
