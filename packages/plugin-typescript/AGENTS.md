# @metator/plugin-typescript

`ImportAnalyzer`, `SymbolAnalyzer`, `DeclarationEmitter` and the `tsc` rule engine.

- oxc parses and resolves imports; `tsc` runs only for declarations and compiler-option rules.
- Pitfall: A fingerprint change invalidates the import index cache: change it when parsing output changes.
