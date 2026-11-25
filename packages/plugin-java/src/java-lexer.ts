/**
 * A Java tokenizer for the facts that are lexical: the package, imports, the type names a file
 * uses and its declarations with their modifiers. Comments, strings, text blocks and character
 * literals are skipped, so a word in a comment or a string is never a reference. It never fails:
 * a file with a syntax error still has its imports and declarations.
 */

export interface JavaToken {
  readonly text: string;
  /** `ident` (identifiers and keywords), `punct` (one character), `literal` (numbers). */
  readonly kind: "ident" | "punct" | "literal";
  readonly line: number;
}

const isIdentStart = (c: number) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
const isIdentPart = (c: number) => isIdentStart(c) || (c >= 48 && c <= 57);

export function tokenize(src: string): JavaToken[] {
  const out: JavaToken[] = [];
  let line = 1;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 10) {
      line++;
      i++;
    } else if (c === 32 || c === 9 || c === 13 || c === 12) i++;
    else if (c === 47 && src.charCodeAt(i + 1) === 47) {
      while (i < n && src.charCodeAt(i) !== 10) i++;
    } else if (c === 47 && src.charCodeAt(i + 1) === 42) {
      i += 2;
      while (i < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) {
        if (src.charCodeAt(i) === 10) line++;
        i++;
      }
      i += 2;
    } else if (c === 34 && src.startsWith('"""', i)) {
      i += 3;
      while (i < n && !src.startsWith('"""', i)) {
        if (src.charCodeAt(i) === 92) i++;
        else if (src.charCodeAt(i) === 10) line++;
        i++;
      }
      i += 3;
      out.push({ text: '""', kind: "literal", line });
    } else if (c === 34 || c === 39) {
      const start = line;
      i++;
      while (i < n && src.charCodeAt(i) !== c && src.charCodeAt(i) !== 10) {
        if (src.charCodeAt(i) === 92) i++;
        i++;
      }
      i++;
      out.push({ text: c === 34 ? '""' : "''", kind: "literal", line: start });
    } else if (isIdentStart(c)) {
      const s = i;
      while (i < n && isIdentPart(src.charCodeAt(i))) i++;
      out.push({ text: src.slice(s, i), kind: "ident", line });
    } else if (c >= 48 && c <= 57) {
      const s = i;
      while (i < n && /[\w.]/.test(src[i] as string)) i++;
      out.push({ text: src.slice(s, i), kind: "literal", line });
    } else {
      out.push({ text: src[i] as string, kind: "punct", line });
      i++;
    }
  }
  return out;
}

interface LexicalImport {
  readonly name: string;
  readonly static: boolean;
  readonly onDemand: boolean;
  readonly line: number;
}

interface LexicalMember {
  readonly name: string;
  readonly line: number;
  readonly public: boolean;
}

interface LexicalType {
  readonly name: string;
  readonly kind: "class" | "interface" | "enum" | "record" | "annotation";
  readonly line: number;
  readonly members: readonly LexicalMember[];
}

export interface LexicalFile {
  readonly package: string;
  readonly imports: readonly LexicalImport[];
  /** Top-level types with their members. */
  readonly types: readonly LexicalType[];
  /** Every type name the file declares, nested ones included. */
  readonly declared: ReadonlySet<string>;
  /** Identifiers that start with an upper-case letter, with the first line each appears on. */
  readonly references: ReadonlyMap<string, number>;
}

const TYPE_WORDS = new Set(["class", "interface", "enum"]);

/** The kind a declaration keyword starts at token `i`, with the index of its name; undefined otherwise. */
function declarationAt(
  t: readonly JavaToken[],
  i: number,
): { kind: LexicalType["kind"]; name: number } | undefined {
  const tok = t[i];
  if (tok?.kind !== "ident") return undefined;
  const next = t[i + 1];
  if (tok.text === "interface" && t[i - 1]?.text === "@" && next?.kind === "ident")
    return { kind: "annotation", name: i + 1 };
  if (TYPE_WORDS.has(tok.text) && next?.kind === "ident" && t[i - 1]?.text !== ".")
    return { kind: tok.text as "class" | "interface" | "enum", name: i + 1 };
  // `record` is a contextual keyword: `record Name(` or `record Name<`.
  if (tok.text === "record" && next?.kind === "ident" && (t[i + 2]?.text === "(" || t[i + 2]?.text === "<"))
    return { kind: "record", name: i + 1 };
  return undefined;
}

/** Skips an annotation starting at `@` (index i); returns the index after it. */
function skipAnnotation(t: readonly JavaToken[], i: number): number {
  let j = i + 1;
  while (t[j]?.kind === "ident" && t[j + 1]?.text === "." && t[j + 2]?.kind === "ident") j += 2;
  j++;
  if (t[j]?.text === "(") {
    let depth = 0;
    for (; j < t.length; j++) {
      if (t[j]?.text === "(") depth++;
      else if (t[j]?.text === ")" && --depth === 0) return j + 1;
    }
  }
  return j;
}

/** The names a member declaration header declares (methods: the name before `(`; fields: before `=`, `,`, `;`). */
function memberOf(header: readonly JavaToken[], typeName: string, inInterface: boolean): LexicalMember[] {
  const toks: JavaToken[] = [];
  for (let i = 0; i < header.length; ) {
    if (header[i]?.text === "@" && header[i + 1]?.text !== "interface") i = skipAnnotation(header, i);
    else toks.push(header[i++] as JavaToken);
  }
  if (toks.length === 0) return [];
  const words = new Set(toks.filter((x) => x.kind === "ident").map((x) => x.text));
  const isPublic = words.has("public") || (inInterface && !words.has("private"));
  if (toks.some((_x, i) => declarationAt(toks, i))) return [];
  const paren = toks.findIndex((x) => x.text === "(");
  const eq = toks.findIndex((x) => x.text === "=");
  if (paren >= 0 && (eq < 0 || paren < eq)) {
    const name = toks[paren - 1];
    if (name?.kind !== "ident" || name.text === typeName) return [];
    return [{ name: name.text, line: name.line, public: isPublic }];
  }
  const out: LexicalMember[] = [];
  let angle = 0;
  for (let i = 0; i < toks.length; i++) {
    const x = toks[i] as JavaToken;
    if (x.text === "<") angle++;
    else if (x.text === ">") angle--;
    else if (angle === 0 && (x.text === "=" || x.text === "," || i === toks.length - 1)) {
      const name = x.kind === "ident" && i === toks.length - 1 ? x : toks[i - 1];
      if (name?.kind === "ident" && !out.some((m) => m.name === name.text))
        out.push({ name: name.text, line: name.line, public: isPublic });
      if (x.text === "=") break;
    }
  }
  return out;
}

/** The lexical facts of one file. */
export function lexJava(src: string): LexicalFile {
  const t = tokenize(src);
  let pkg = "";
  const imports: LexicalImport[] = [];
  const types: LexicalType[] = [];
  const declared = new Set<string>();
  const references = new Map<string, number>();
  let depth = 0;
  let parens = 0;
  /** Braces opened inside parentheses (annotation arrays, lambdas in arguments): not structure. */
  const inline: boolean[] = [];
  let current: { type: LexicalType; members: LexicalMember[]; enumConstants: boolean } | undefined;
  let header: JavaToken[] = [];
  const skipUntil = 0;

  for (let i = 0; i < t.length; i++) {
    const tok = t[i] as JavaToken;
    if (
      depth === 0 &&
      tok.kind === "ident" &&
      (tok.text === "package" || tok.text === "import") &&
      parens === 0
    ) {
      let j = i + 1;
      const isStatic = tok.text === "import" && t[j]?.text === "static";
      if (isStatic) j++;
      const parts: string[] = [];
      let onDemand = false;
      for (; j < t.length && t[j]?.text !== ";"; j++) {
        const x = t[j] as JavaToken;
        if (x.text === "*") onDemand = true;
        else if (x.kind === "ident") parts.push(x.text);
      }
      if (tok.text === "package") pkg = parts.join(".");
      else imports.push({ name: parts.join("."), static: isStatic, onDemand, line: tok.line });
      i = j;
      continue;
    }
    const decl = declarationAt(t, i);
    if (decl) declared.add((t[decl.name] as JavaToken).text);
    if (tok.kind === "ident" && i >= skipUntil) {
      const c = tok.text.charCodeAt(0);
      if (c >= 65 && c <= 90 && !references.has(tok.text)) references.set(tok.text, tok.line);
    }
    if (decl && depth === 0) {
      const type: LexicalType = {
        name: (t[decl.name] as JavaToken).text,
        kind: decl.kind,
        line: (t[decl.name] as JavaToken).line,
        members: [],
      };
      current = { type, members: type.members as LexicalMember[], enumConstants: decl.kind === "enum" };
      types.push(type);
    }
    if (tok.text === "(") parens++;
    else if (tok.text === ")") parens = Math.max(0, parens - 1);
    else if (tok.text === "{") {
      const isInline = parens > 0;
      inline.push(isInline);
      if (!isInline) {
        if (depth === 1 && current) {
          if (current.enumConstants) {
            current.members.push(...enumConstantsOf(header));
          } else
            current.members.push(
              ...memberOf(
                header,
                current.type.name,
                current.type.kind === "interface" || current.type.kind === "annotation",
              ),
            );
          header = [];
        }
        depth++;
        if (depth === 1) header = [];
      }
      continue;
    } else if (tok.text === "}") {
      const wasInline = inline.pop();
      if (!wasInline) {
        depth = Math.max(0, depth - 1);
        if (depth === 1) header = [];
        if (depth === 0) current = undefined;
      }
      continue;
    }
    if (depth === 1 && current) {
      if (tok.text === ";" && parens === 0) {
        if (current.enumConstants) {
          current.members.push(...enumConstantsOf(header));
          current.enumConstants = false;
        } else
          current.members.push(
            ...memberOf(
              header,
              current.type.name,
              current.type.kind === "interface" || current.type.kind === "annotation",
            ),
          );
        header = [];
      } else if (tok.text === "," && parens === 0 && current.enumConstants) {
        current.members.push(...enumConstantsOf(header));
        header = [];
      } else header.push(tok);
    }
  }
  if (current?.enumConstants && header.length > 0) current.members.push(...enumConstantsOf(header));
  return { package: pkg, imports, types, declared, references };
}

function enumConstantsOf(header: readonly JavaToken[]): LexicalMember[] {
  let i = 0;
  while (header[i]?.text === "@") i = skipAnnotation(header, i);
  const name = header[i];
  return name?.kind === "ident" ? [{ name: name.text, line: name.line, public: true }] : [];
}
