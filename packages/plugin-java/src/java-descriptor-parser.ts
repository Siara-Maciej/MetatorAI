import {
  err,
  type JavaConfigEntry,
  type JavaDescriptorFacts,
  type JavaDescriptorParser,
  type JavaPersistenceUnit,
  type JavaServletMapping,
  type JavaXmlBean,
  MetatorError,
  NO_DESCRIPTOR_FACTS,
  ok,
  profileOfConfigFile,
  type Result,
} from "@metator/core";
import { isMap, isScalar, isSeq, LineCounter, type Node, parseAllDocuments } from "yaml";
import { child, children, childText, parseXml, type XmlElement } from "./xml.ts";

/**
 * Java descriptors read for framework facts (ADR-0107): `web.xml` servlets and their mappings,
 * `persistence.xml` units, Spring XML `<bean>` definitions, and `application*.properties` /
 * `application*.yml` keys with their profile (from the file name, or a document's
 * `spring.config.activate.on-profile` / `spring.profiles`). A file that does not parse is an
 * error value; any other XML is no facts.
 */
export class JavaDescriptors implements JavaDescriptorParser {
  parse(path: string, content: string): Result<JavaDescriptorFacts, MetatorError> {
    const failed = (message: string) =>
      err(new MetatorError("PARSE_FAILED", `${path}: ${message}`, { details: { path } }));
    if (/\.properties$/.test(path))
      return ok({ ...NO_DESCRIPTOR_FACTS, config: properties(content, profileOfConfigFile(path)) });
    if (/\.ya?ml$/.test(path)) {
      const config = yamlConfig(content, profileOfConfigFile(path));
      return config.isOk()
        ? ok({ ...NO_DESCRIPTOR_FACTS, config: config.value })
        : failed(config.error.message);
    }
    if (!path.endsWith(".xml")) return ok(NO_DESCRIPTOR_FACTS);
    const xml = parseXml(content);
    return xml.isOk() ? ok(xmlFacts(xml.value)) : failed(xml.error.message);
  }
}

function xmlFacts(root: XmlElement): JavaDescriptorFacts {
  if (root.name === "web-app") return { ...NO_DESCRIPTOR_FACTS, servlets: servlets(root) };
  if (root.name === "persistence") return { ...NO_DESCRIPTOR_FACTS, persistenceUnits: units(root) };
  if (root.name === "beans") return { ...NO_DESCRIPTOR_FACTS, beans: beans(root) };
  return NO_DESCRIPTOR_FACTS;
}

function servlets(root: XmlElement): JavaServletMapping[] {
  const patterns = new Map<string, string[]>();
  for (const m of children(root, "servlet-mapping")) {
    const name = childText(m, "servlet-name");
    if (!name) continue;
    const list = patterns.get(name) ?? [];
    for (const p of children(m, "url-pattern")) if (p.text) list.push(p.text);
    patterns.set(name, list);
  }
  const out: JavaServletMapping[] = [];
  for (const s of children(root, "servlet")) {
    const name = childText(s, "servlet-name");
    const className = childText(s, "servlet-class");
    if (!name || !className) continue;
    out.push({ name, className, urlPatterns: patterns.get(name) ?? [], line: s.line });
  }
  return out;
}

function units(root: XmlElement): JavaPersistenceUnit[] {
  return children(root, "persistence-unit").map((u) => {
    const provider = childText(u, "provider");
    const tx = u.attributes["transaction-type"];
    return {
      name: u.attributes.name ?? "",
      ...(tx ? { transactionType: tx } : {}),
      ...(provider ? { provider } : {}),
      classes: children(u, "class")
        .map((c) => c.text)
        .filter((c) => c !== ""),
      line: u.line,
    };
  });
}

function beans(root: XmlElement): JavaXmlBean[] {
  const out: JavaXmlBean[] = [];
  const visit = (el: XmlElement) => {
    for (const b of children(el, "bean")) {
      const className = b.attributes.class;
      if (className) {
        const id = b.attributes.id ?? b.attributes.name?.split(/[,;\s]+/)[0];
        const scope = b.attributes.scope;
        out.push({
          ...(id ? { id } : {}),
          className,
          ...(scope ? { scope } : {}),
          line: b.line,
          properties: children(b, "property").map((p) => {
            const ref = p.attributes.ref ?? child(p, "ref")?.attributes.bean;
            const value = p.attributes.value ?? childText(p, "value");
            return {
              name: p.attributes.name ?? "",
              ...(ref ? { ref } : {}),
              ...(value !== undefined ? { value } : {}),
              line: p.line,
            };
          }),
          constructorArgs: children(b, "constructor-arg").map((a) => {
            const ref = a.attributes.ref ?? child(a, "ref")?.attributes.bean;
            const value = a.attributes.value ?? childText(a, "value");
            return { ...(ref ? { ref } : {}), ...(value !== undefined ? { value } : {}), line: a.line };
          }),
        });
      }
      visit(b);
    }
    // <beans profile="dev"> nested in the root holds beans too.
    for (const nested of children(el, "beans")) visit(nested);
  };
  visit(root);
  return out;
}

/** `key=value`, `key: value`, `key value`; `#`/`!` comments; `\` continues a line; `#---` starts a document. */
export function properties(text: string, fileProfile: string | undefined): JavaConfigEntry[] {
  const lines = text.split(/\r?\n/);
  const docs: JavaConfigEntry[][] = [[]];
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i] as string;
    const start = i + 1;
    if (/^\s*[#!]---\s*$/.test(raw)) {
      docs.push([]);
      continue;
    }
    if (/^\s*([#!]|$)/.test(raw)) continue;
    while (/(^|[^\\])(\\\\)*\\$/.test(raw) && i + 1 < lines.length)
      raw = raw.slice(0, -1) + (lines[++i] as string).trimStart();
    const m = /^\s*((?:\\.|[^=:\s\\])+)\s*[=:\s]\s*(.*)$/.exec(raw);
    const key = (m?.[1] ?? raw.trim()).replace(/\\(.)/g, "$1");
    (docs.at(-1) as JavaConfigEntry[]).push({ key, value: m?.[2] ?? "", line: start });
  }
  return docs.flatMap((entries) => withProfile(entries, fileProfile));
}

/** A document's own profile wins over the file's: `spring.config.activate.on-profile`, `spring.profiles`. */
function withProfile(
  entries: readonly JavaConfigEntry[],
  fileProfile: string | undefined,
): JavaConfigEntry[] {
  const own = entries.find(
    (e) => e.key === "spring.config.activate.on-profile" || e.key === "spring.profiles",
  )?.value;
  const profile = own && own.trim() !== "" ? own.trim() : fileProfile;
  return entries.map((e) => ({ key: e.key, value: e.value, ...(profile ? { profile } : {}), line: e.line }));
}

/** Every leaf of every document, as a dotted key (`shop.orders.max-lines`, `list[0]`). */
export function yamlConfig(
  text: string,
  fileProfile: string | undefined,
): Result<JavaConfigEntry[], MetatorError> {
  const counter = new LineCounter();
  const out: JavaConfigEntry[] = [];
  for (const doc of parseAllDocuments(text, { lineCounter: counter })) {
    if (doc.errors.length > 0)
      return err(new MetatorError("PARSE_FAILED", doc.errors[0]?.message.split("\n")[0] ?? "invalid YAML"));
    const entries: JavaConfigEntry[] = [];
    const lineOf = (n: Node | null | undefined) => (n?.range ? counter.linePos(n.range[0]).line : 0);
    const leaf = (key: string, n: Node | null | undefined, at: number) => {
      if (isMap(n)) {
        for (const pair of n.items) {
          const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
          leaf(key ? `${key}.${k}` : k, pair.value as Node | null, lineOf(pair.key as Node));
        }
      } else if (isSeq(n)) {
        n.items.forEach((item, i) => {
          leaf(`${key}[${i}]`, item as Node, lineOf(item as Node) || at);
        });
      } else if (key) {
        const value = isScalar(n) ? (n.value === null ? "" : String(n.value)) : n ? String(n) : "";
        entries.push({ key, value, line: at });
      }
    };
    leaf("", doc.contents as Node | null, 1);
    out.push(...withProfile(entries, fileProfile));
  }
  return ok(out);
}
