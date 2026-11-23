# @metator/plugin-java

Java repositories, read without a JDK (ADR-0107): `TreeSitterJavaParser` (`JavaSourceParser`, web-tree-sitter running tree-sitter-java's WebAssembly grammar), `JavaBuildFiles` (`JavaBuildReader`: Maven POMs and Gradle scripts, never run), `JavaDescriptors` (`JavaDescriptorParser`: web.xml, persistence.xml, Spring XML, `application*.{properties,yml}`), `JavaImportAnalyzer` (`ImportAnalyzer` and `SymbolAnalyzer` for `.java`) and `JavaWorkspace` (modules as workspace packages).

- The framework facts (endpoints, entities, beans, config, entry points) are core's domain (`java-*.ts`); this package only reads files into the model.
- A file with a syntax error is facts plus `error`, never a failure; XML or YAML that does not parse is a `PARSE_FAILED` value.
- Imports are lexical (`java-lexer.ts`): the port is synchronous and tree-sitter's WebAssembly starts asynchronously. The parser serves `metator java`.
- Pitfall: `TreeSitterJavaParser.id` and `JavaImportAnalyzer.id` are cache keys: bump the suffix when what they extract changes.
- Pitfall: a compiled `metator` has no node_modules; the runtime hands the parser the `.wasm` files from `metator-resources/wasm` (`javaGrammarFiles` in packages/cli/src/installation.ts).
- `JavaImportAnalyzer` passes `importAnalyzerContract` from `@metator/testing`.
