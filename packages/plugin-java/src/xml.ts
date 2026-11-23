import { err, MetatorError, ok, type Result } from "@metator/core";
import { SaxesParser } from "saxes";

/** An XML element with the line it starts on: the little DOM the build and descriptor readers walk. */
export interface XmlElement {
  /** Local name, without a namespace prefix. */
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
  text: string;
  readonly line: number;
}

/** Parses XML (saxes) into elements; XML that is not well-formed is an error value. */
export function parseXml(text: string): Result<XmlElement, MetatorError> {
  const parser = new SaxesParser({ xmlns: false, position: true });
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let start = 1;
  parser.on("opentagstart", () => {
    start = parser.line;
  });
  parser.on("opentag", (tag) => {
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(tag.attributes)) attributes[localName(k)] = String(v);
    const el: XmlElement = { name: localName(tag.name), attributes, children: [], text: "", line: start };
    stack.at(-1)?.children.push(el);
    if (!root) root = el;
    stack.push(el);
  });
  parser.on("text", (t) => {
    const top = stack.at(-1);
    if (top) top.text += t;
  });
  parser.on("cdata", (t) => {
    const top = stack.at(-1);
    if (top) top.text += t;
  });
  parser.on("closetag", () => {
    const top = stack.pop();
    if (top) top.text = top.text.trim();
  });
  // Without an error handler saxes throws: the first error ends the parse.
  try {
    parser.write(text).close();
  } catch (e) {
    return err(new MetatorError("PARSE_FAILED", (e as Error).message.split("\n")[0] ?? "invalid XML"));
  }
  return root ? ok(root) : err(new MetatorError("PARSE_FAILED", "no root element"));
}

const localName = (name: string) => name.slice(name.indexOf(":") + 1);

/** The first child element named `name`. */
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name);
}

/** Every child element named `name`. */
export function children(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : [];
}

/** The trimmed text of the child `name`, or undefined. */
export function childText(el: XmlElement | undefined, name: string): string | undefined {
  const c = child(el, name);
  return c && c.text !== "" ? c.text : undefined;
}
