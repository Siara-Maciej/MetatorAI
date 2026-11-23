import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  err,
  type JavaAnnotation,
  type JavaCall,
  type JavaConstructor,
  type JavaField,
  type JavaImport,
  type JavaMethod,
  type JavaParameter,
  type JavaParsedFile,
  type JavaSourceParser,
  type JavaTypeDecl,
  type JavaTypeKind,
  type JavaValue,
  MetatorError,
  ok,
  type Result,
} from "@metator/core";
import grammar from "tree-sitter-java/package.json" with { type: "json" };
import { Language, type Node, Parser } from "web-tree-sitter";

/** The two WebAssembly files the parser runs on: web-tree-sitter's runtime and the Java grammar. */
export interface JavaGrammarFiles {
  readonly runtime: string;
  readonly language: string;
}

/** The files in node_modules (a checkout, the npm package); a compiled CLI gives its resources instead. */
export function installedGrammarFiles(): JavaGrammarFiles {
  const require = createRequire(import.meta.url);
  return {
    runtime: require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
    language: require.resolve("tree-sitter-java/tree-sitter-java.wasm"),
  };
}

const DECLARATIONS: Readonly<Record<string, JavaTypeKind>> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  annotation_type_declaration: "annotation",
};

/** Calls of the functional routing DSLs (Spring WebFlux RouterFunctions) a framework rule reads. */
const ROUTER_CALLS = new Set([
  "route",
  "nest",
  "path",
  "andRoute",
  "andNest",
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
]);

/** `List < String >` → `List<String>`, `? extends T` kept readable. */
export function normalizeType(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*([<>,[\]])\s*/g, "$1")
    .replace(/\s*\.\s*/g, ".")
    .trim();
}

function unescapeJava(s: string): string {
  return s.replace(/\\(u+[0-9a-fA-F]{4}|[btnfrs"'\\]|[0-7]{1,3})/g, (_m, e: string) => {
    if (e.startsWith("u")) return String.fromCharCode(Number.parseInt(e.replace(/^u+/, ""), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(Number.parseInt(e, 8));
    const map: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", s: " " };
    return map[e] ?? e;
  });
}

/** A text block's content: incidental indentation and the opening line break removed (JLS 3.10.6). */
export function textBlock(raw: string): string {
  const lines = raw.replace(/^[ \t]*\r?\n/, "").split(/\r?\n/);
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0);
  const last = lines.at(-1) ?? "";
  if (last.trim() === "") indents.push(last.length);
  const strip = indents.length > 0 ? Math.min(...indents) : 0;
  return unescapeJava(
    lines
      .map((l) => l.slice(strip).replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\\\n/g, ""),
  );
}

/**
 * Java on tree-sitter (ADR-0107): web-tree-sitter runs tree-sitter-java's grammar compiled to
 * WebAssembly, so reading needs no JDK, no native addon and no network. The grammar is
 * error-tolerant: a file with a syntax error still yields every declaration around the error,
 * and the file is reported (`error`) instead of stopping the reading.
 */
export class TreeSitterJavaParser implements JavaSourceParser {
  /** Cache key of the Java index: bump the suffix when what `parse` extracts changes. */
  static readonly id = `tree-sitter-java@${grammar.version}/2`;
  readonly id = TreeSitterJavaParser.id;
  private ready: Promise<Result<Parser, MetatorError>> | undefined;

  constructor(private readonly files: () => JavaGrammarFiles = installedGrammarFiles) {}

  private parser(): Promise<Result<Parser, MetatorError>> {
    this.ready ??= (async () => {
      let files: JavaGrammarFiles | undefined;
      try {
        files = this.files();
        await Parser.init({ wasmBinary: readFileSync(files.runtime) } as Parameters<typeof Parser.init>[0]);
        const language = await Language.load(new Uint8Array(readFileSync(files.language)));
        const parser = new Parser();
        parser.setLanguage(language);
        return ok(parser);
      } catch (e) {
        return err(
          new MetatorError("BIN_NOT_FOUND", `the Java parser cannot load: ${(e as Error).message}`, {
            hint: "Reinstall MetatorAI: the Java grammar (tree-sitter-java.wasm) ships with it.",
            details: files ? { runtime: files.runtime, language: files.language } : {},
          }),
        );
      }
    })();
    return this.ready;
  }

  async parse(path: string, content: string): Promise<Result<JavaParsedFile, MetatorError>> {
    const parser = await this.parser();
    if (parser.isErr()) return err(parser.error);
    const tree = parser.value.parse(content);
    if (!tree) return err(new MetatorError("PARSE_FAILED", `${path}: the parser returned no tree`));
    try {
      return ok(extract(tree.rootNode));
    } catch (e) {
      return err(new MetatorError("PARSE_FAILED", `${path}: ${(e as Error).message}`));
    } finally {
      tree.delete();
    }
  }
}

const line = (n: Node) => n.startPosition.row + 1;
/** A declaration's line is its name's, not its annotations' (they have their own lines). */
const nameLine = (n: Node) => line(n.childForFieldName("name") ?? n);
const named = (n: Node | null | undefined): Node[] => (n ? (n.namedChildren.filter(Boolean) as Node[]) : []);

/** Everything the file declares and uses. */
export function extract(root: Node): JavaParsedFile {
  let pkg = "";
  const imports: JavaImport[] = [];
  const types: JavaTypeDecl[] = [];
  for (const child of named(root)) {
    if (child.type === "package_declaration") {
      const id = named(child).find((c) => c.type === "scoped_identifier" || c.type === "identifier");
      if (id) pkg = normalizeType(id.text);
    } else if (child.type === "import_declaration") {
      const id = named(child).find((c) => c.type === "scoped_identifier" || c.type === "identifier");
      if (!id) continue;
      imports.push({
        name: normalizeType(id.text),
        static: child.children.some((c) => c?.type === "static"),
        onDemand: child.children.some((c) => c?.type === "asterisk"),
        line: line(child),
      });
    } else if (DECLARATIONS[child.type]) types.push(typeDecl(child, pkg ? `${pkg}.` : ""));
  }
  const { references, calls, error } = walk(root, types, pkg);
  return { package: pkg, imports, types, references, calls, ...(error ? { error } : {}) };
}

/** One cursor walk over the whole tree: type names used, router calls, the first syntax error. */
function walk(
  root: Node,
  types: readonly JavaTypeDecl[],
  pkg: string,
): { references: string[]; calls: JavaCall[]; error?: { message: string; line: number } } {
  const refs = new Set<string>();
  const invocations: Node[] = [];
  let error: { message: string; line: number } | undefined;
  const cursor = root.walk();
  try {
    for (;;) {
      const type = cursor.nodeType;
      if (type === "type_identifier") refs.add(cursor.nodeText);
      else if (type === "identifier") {
        const c = cursor.nodeText.charCodeAt(0);
        if (c >= 65 && c <= 90) refs.add(cursor.nodeText);
      } else if (type === "method_invocation") {
        const node = cursor.currentNode;
        const name = node.childForFieldName("name")?.text;
        if (name && ROUTER_CALLS.has(name)) invocations.push(node);
      } else if (!error && (type === "ERROR" || cursor.nodeIsMissing)) {
        error = {
          message:
            type === "ERROR"
              ? `syntax error near "${cursor.nodeText.slice(0, 40).replace(/\s+/g, " ")}"`
              : `syntax error: missing "${type}"`,
          line: cursor.startPosition.row + 1,
        };
      }
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent())
          return {
            references: [...refs].sort(),
            calls: callsOf(invocations, types, pkg),
            ...(error ? { error } : {}),
          };
      }
    }
  } finally {
    cursor.delete();
  }
}

/** The router calls, each knowing the call it is an argument of or the end of the chain it starts. */
function callsOf(nodes: readonly Node[], types: readonly JavaTypeDecl[], pkg: string): JavaCall[] {
  const index = new Map<number, number>();
  nodes.forEach((n, i) => {
    index.set(n.id, i);
  });
  return nodes.map((n) => {
    let within: number | undefined;
    for (let p = n.parent; p && within === undefined; p = p.parent) {
      if (p.type === "method_invocation" && index.has(p.id)) within = index.get(p.id);
      if (p.type === "method_declaration" || p.type === "class_body") break;
    }
    const args = named(n.childForFieldName("arguments")).map(value);
    return {
      name: n.childForFieldName("name")?.text ?? "",
      arguments: args,
      // A chain's call starts where the chain does (`route()` above `.GET(...)`): its own line is its name's.
      line: nameLine(n),
      ...(within === undefined ? {} : { within }),
      in: enclosing(n, types, pkg),
    };
  });
}

/** `com.example.Routes#routes` for a call in method `routes` of `Routes`. */
function enclosing(n: Node, _types: readonly JavaTypeDecl[], pkg: string): string {
  let method = "";
  const owners: string[] = [];
  for (let p = n.parent; p; p = p.parent) {
    if (!method && (p.type === "method_declaration" || p.type === "constructor_declaration"))
      method = p.childForFieldName("name")?.text ?? "";
    if (DECLARATIONS[p.type]) owners.unshift(p.childForFieldName("name")?.text ?? "");
  }
  const type = `${pkg ? `${pkg}.` : ""}${owners.join(".")}`;
  return method ? `${type}#${method}` : type;
}

function modifiersOf(decl: Node): { modifiers: string[]; annotations: JavaAnnotation[] } {
  const node = decl.children.find((c) => c?.type === "modifiers");
  const modifiers: string[] = [];
  const annotations: JavaAnnotation[] = [];
  if (!node) return { modifiers, annotations };
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === "marker_annotation" || c.type === "annotation") annotations.push(annotation(c));
    else if (!c.isNamed || c.type === "static") modifiers.push(c.text);
  }
  return { modifiers: [...new Set(modifiers)], annotations };
}

export function annotation(n: Node): JavaAnnotation {
  const args: Record<string, JavaValue> = {};
  for (const a of named(n.childForFieldName("arguments"))) {
    if (a.type === "element_value_pair") {
      const key = a.childForFieldName("key")?.text;
      const v = a.childForFieldName("value");
      if (key && v) args[key] = value(v);
    } else if (a.type !== "comment" && a.type !== "line_comment" && a.type !== "block_comment")
      args.value = value(a);
  }
  return { name: normalizeType(n.childForFieldName("name")?.text ?? ""), arguments: args, line: line(n) };
}

/** An expression as a value: literals evaluated, string concatenations joined, arrays itemized. */
export function value(n: Node): JavaValue {
  const text = n.text.replace(/\s+/g, " ").trim();
  switch (n.type) {
    case "string_literal": {
      const multiline = n.namedChildren.some((c) => c?.type === "multiline_string_fragment");
      if (multiline) {
        const raw = n.text.slice(3, -3);
        return { text, value: textBlock(raw) };
      }
      return { text, value: unescapeJava(n.text.slice(1, -1)) };
    }
    case "parenthesized_expression": {
      const inner = named(n)[0];
      return inner ? { ...value(inner), text } : { text };
    }
    case "binary_expression": {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      const op = n.childForFieldName("operator")?.text ?? n.children.find((c) => c && !c.isNamed)?.text;
      if (op === "+" && left && right) {
        const l = value(left);
        const r = value(right);
        if (typeof l.value === "string" && r.value !== undefined)
          return { text, value: l.value + String(r.value) };
        if (typeof r.value === "string" && l.value !== undefined)
          return { text, value: String(l.value) + r.value };
      }
      return { text };
    }
    case "true":
      return { text, value: true };
    case "false":
      return { text, value: false };
    case "decimal_integer_literal":
    case "hex_integer_literal":
    case "octal_integer_literal":
    case "binary_integer_literal": {
      const num = Number(n.text.replace(/[_lL]/g, ""));
      return Number.isFinite(num) ? { text, value: num } : { text };
    }
    case "decimal_floating_point_literal": {
      const num = Number.parseFloat(n.text.replace(/[_fFdD]/g, ""));
      return Number.isFinite(num) ? { text, value: num } : { text };
    }
    case "character_literal":
      return { text, value: unescapeJava(n.text.slice(1, -1)) };
    case "element_value_array_initializer":
    case "array_initializer":
      return { text, items: named(n).filter(isExpression).map(value) };
    default:
      return { text };
  }
}

const isExpression = (n: Node) => !n.type.endsWith("comment");

function typeText(n: Node | null | undefined): string {
  return n ? normalizeType(n.text) : "";
}

function typeList(n: Node | null | undefined): string[] {
  if (!n) return [];
  const list = named(n).find((c) => c.type === "type_list");
  return (list ? named(list) : named(n)).map(typeText);
}

function parameters(n: Node | null | undefined): JavaParameter[] {
  const out: JavaParameter[] = [];
  for (const p of named(n)) {
    if (p.type === "formal_parameter") {
      const { annotations } = modifiersOf(p);
      const dims = p.childForFieldName("dimensions")?.text ?? "";
      out.push({
        name: p.childForFieldName("name")?.text ?? "",
        type: typeText(p.childForFieldName("type")) + normalizeType(dims),
        annotations,
      });
    } else if (p.type === "spread_parameter") {
      const { annotations } = modifiersOf(p);
      const type = named(p).find((c) => c.type !== "modifiers" && c.type !== "variable_declarator");
      const decl = named(p).find((c) => c.type === "variable_declarator");
      out.push({
        name: decl?.childForFieldName("name")?.text ?? "",
        type: `${typeText(type)}...`,
        annotations,
        varargs: true,
      });
    }
  }
  return out;
}

function throwsOf(n: Node): string[] {
  const t = n.children.find((c) => c?.type === "throws");
  return t ? named(t).map(typeText) : [];
}

function typeParametersOf(n: Node): string[] {
  return named(n.childForFieldName("type_parameters")).map((p) => normalizeType(p.text));
}

function fieldsOf(n: Node): JavaField[] {
  const { modifiers, annotations } = modifiersOf(n);
  const type = typeText(n.childForFieldName("type"));
  return named(n)
    .filter((c) => c.type === "variable_declarator")
    .map((d) => {
      const init = d.childForFieldName("value");
      const v = init ? value(init) : undefined;
      const dims = d.childForFieldName("dimensions")?.text ?? "";
      return {
        name: d.childForFieldName("name")?.text ?? "",
        type: type + normalizeType(dims),
        modifiers,
        annotations,
        line: nameLine(d),
        ...(v && v.value !== undefined ? { value: v } : {}),
      };
    });
}

function methodOf(n: Node): JavaMethod {
  const { modifiers, annotations } = modifiersOf(n);
  return {
    name: n.childForFieldName("name")?.text ?? "",
    returnType:
      typeText(n.childForFieldName("type")) + normalizeType(n.childForFieldName("dimensions")?.text ?? ""),
    parameters: parameters(n.childForFieldName("parameters")),
    throws: throwsOf(n),
    modifiers,
    annotations,
    typeParameters: typeParametersOf(n),
    line: nameLine(n),
  };
}

function constructorOf(n: Node, components: readonly JavaParameter[]): JavaConstructor {
  const { modifiers, annotations } = modifiersOf(n);
  return {
    // A compact canonical constructor takes the record's components.
    parameters:
      n.type === "compact_constructor_declaration"
        ? [...components]
        : parameters(n.childForFieldName("parameters")),
    throws: throwsOf(n),
    modifiers,
    annotations,
    line: nameLine(n),
  };
}

export function typeDecl(n: Node, prefix: string): JavaTypeDecl {
  const kind = DECLARATIONS[n.type] as JavaTypeKind;
  const name = n.childForFieldName("name")?.text ?? "";
  const qualifiedName = `${prefix}${name}`;
  const { modifiers, annotations } = modifiersOf(n);
  const superclass = n.childForFieldName("superclass");
  const extendsInterfaces = n.children.find((c) => c?.type === "extends_interfaces");
  const components = kind === "record" ? parameters(n.childForFieldName("parameters")) : [];
  const fields: JavaField[] = [];
  const constructors: JavaConstructor[] = [];
  const methods: JavaMethod[] = [];
  const nested: JavaTypeDecl[] = [];
  const enumConstants: string[] = [];
  const members = (body: Node | null | undefined) => {
    for (const m of named(body)) {
      switch (m.type) {
        case "field_declaration":
        case "constant_declaration":
          fields.push(...fieldsOf(m));
          break;
        case "method_declaration":
          methods.push(methodOf(m));
          break;
        case "annotation_type_element_declaration": {
          const { modifiers: mods, annotations: anns } = modifiersOf(m);
          methods.push({
            name: m.childForFieldName("name")?.text ?? "",
            returnType: typeText(m.childForFieldName("type")),
            parameters: [],
            throws: [],
            modifiers: mods,
            annotations: anns,
            typeParameters: [],
            line: nameLine(m),
          });
          break;
        }
        case "constructor_declaration":
        case "compact_constructor_declaration":
          constructors.push(constructorOf(m, components));
          break;
        case "enum_constant":
          enumConstants.push(m.childForFieldName("name")?.text ?? "");
          break;
        case "enum_body_declarations":
          members(m);
          break;
        default:
          if (DECLARATIONS[m.type]) nested.push(typeDecl(m, `${qualifiedName}.`));
      }
    }
  };
  members(n.childForFieldName("body"));
  return {
    name,
    qualifiedName,
    kind,
    line: nameLine(n),
    modifiers,
    annotations,
    typeParameters: typeParametersOf(n),
    extends: superclass ? named(superclass).map(typeText) : typeList(extendsInterfaces),
    implements: typeList(n.childForFieldName("interfaces")),
    permits: typeList(n.childForFieldName("permits")),
    fields,
    constructors,
    methods,
    enumConstants,
    components,
    nested,
  };
}
