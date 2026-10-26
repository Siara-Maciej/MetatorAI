import { type Claim, ClaimSetDocument, markdownLinks, resolveLink } from "../domain/docs.ts";
import type { MetatorError } from "../domain/errors.ts";
import { markdownAnchors } from "../domain/markdown.ts";
import { locateQuote } from "../domain/memory.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { parseJsonDocument, serializeJsonDocument } from "../domain/versioned.ts";
import type { Clock, FileSystem, ReadonlyFileSystem, RevisionReader } from "../ports/index.ts";
import type { FindOwners } from "./owners.ts";
import type { SourceFiles } from "./source-files.ts";

export interface DeadLink {
  readonly file: string;
  readonly line: number;
  readonly target: string;
  readonly reason: "missing-file" | "missing-anchor";
}

export interface LinksReport {
  readonly documents: number;
  readonly links: number;
  readonly dead: readonly DeadLink[];
}

const isMarkdown = (f: string) => /\.md$/i.test(f);

/**
 * `docs links` (ADR-0045): every relative link in the repository's Markdown points at a file or
 * directory that exists, and a `#anchor` into Markdown at a heading GitHub generates.
 */
export class DocsLinks {
  constructor(
    private readonly sources: SourceFiles,
    private readonly fs: ReadonlyFileSystem,
  ) {}

  async execute(): Promise<Result<LinksReport, MetatorError>> {
    const listed = await this.sources.list();
    if (listed.isErr()) return err(listed.error);
    // A link may point at a file or at a directory that holds files.
    const paths = new Set(listed.value);
    for (const f of listed.value)
      for (let i = f.indexOf("/"); i !== -1; i = f.indexOf("/", i + 1)) paths.add(f.slice(0, i));
    const anchors = new Map<string, Set<string>>();
    const anchorsOf = async (path: string) => {
      let a = anchors.get(path);
      if (!a) {
        const text = await this.fs.read(path);
        a = text.isOk() ? markdownAnchors(text.value) : new Set();
        anchors.set(path, a);
      }
      return a;
    };

    const dead: DeadLink[] = [];
    let documents = 0;
    let links = 0;
    for (const file of listed.value.filter(isMarkdown)) {
      const text = await this.fs.read(file);
      if (text.isErr()) continue;
      documents++;
      for (const link of markdownLinks(text.value)) {
        const to = resolveLink(file, link.target);
        if (to.type === "external") continue;
        links++;
        const report = (reason: DeadLink["reason"]) => {
          dead.push({ file, line: link.line, target: link.target, reason });
        };
        if (!paths.has(to.path)) report("missing-file");
        else if (
          to.anchor !== undefined &&
          isMarkdown(to.path) &&
          !(await anchorsOf(to.path)).has(to.anchor.toLowerCase())
        )
          report("missing-anchor");
      }
    }
    return ok({ documents, links, dead });
  }
}

export interface InventoryRow {
  readonly path: string;
  readonly lines: number;
  /** Date of the last commit that changed it; undefined when not committed yet. */
  readonly lastChanged?: string;
  readonly ageDays?: number;
  readonly owners: readonly string[];
  readonly links: number;
  readonly deadLinks: number;
}

/** `docs inventory` (ADR-0045): every Markdown document with its size, age, owners and links. */
export class DocsInventory {
  constructor(
    private readonly sources: SourceFiles,
    private readonly fs: ReadonlyFileSystem,
    private readonly revisions: Pick<RevisionReader, "lastChanged">,
    private readonly owners: Pick<FindOwners, "execute">,
    private readonly links: Pick<DocsLinks, "execute">,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<
    Result<{ readonly codeowners?: string; readonly documents: readonly InventoryRow[] }, MetatorError>
  > {
    const listed = await this.sources.list();
    if (listed.isErr()) return err(listed.error);
    const docs = listed.value.filter(isMarkdown);
    const changed = await this.revisions.lastChanged();
    if (changed.isErr()) return err(changed.error);
    const owners = await this.owners.execute({ paths: docs });
    if (owners.isErr()) return err(owners.error);
    const links = await this.links.execute();
    if (links.isErr()) return err(links.error);

    const dead = new Map<string, number>();
    for (const d of links.value.dead) dead.set(d.file, (dead.get(d.file) ?? 0) + 1);
    const now = this.clock.now().getTime();
    const rows: InventoryRow[] = [];
    for (const [i, path] of docs.entries()) {
      const text = await this.fs.read(path);
      if (text.isErr()) continue;
      const last = changed.value.get(path);
      rows.push({
        path,
        lines: text.value.split("\n").length,
        ...(last === undefined
          ? {}
          : { lastChanged: last, ageDays: Math.max(0, Math.floor((now - Date.parse(last)) / 86_400_000)) }),
        owners: owners.value.owners[i]?.owners ?? [],
        links: markdownLinks(text.value).filter((l) => resolveLink(path, l.target).type === "file").length,
        deadLinks: dead.get(path) ?? 0,
      });
    }
    return ok({
      ...(owners.value.source === undefined ? {} : { codeowners: owners.value.source }),
      documents: rows,
    });
  }
}

export interface DriftResult {
  readonly id: string;
  readonly source: string;
  readonly status: "ok" | "moved" | "stale" | "missing-file";
  readonly cites: string;
  readonly line?: number;
}

/**
 * `docs drift` (ADR-0045): verified claims are checked against the code again. A quote that
 * moved is reported (and its line fixed with `fix`); a quote that is gone is drift.
 */
export class DocsDrift {
  constructor(
    private readonly fs: FileSystem,
    private readonly file: string,
  ) {}

  async execute(input: {
    readonly fix: boolean;
  }): Promise<
    Result<
      { readonly file: string; readonly checked: number; readonly results: readonly DriftResult[] },
      MetatorError
    >
  > {
    const text = await this.fs.read(this.file);
    // No docs analysis has run yet: there is nothing that could have drifted.
    if (text.isErr()) return ok({ file: this.file, checked: 0, results: [] });
    const set = parseJsonDocument(text.value, this.file).andThen((raw) =>
      ClaimSetDocument.parse(raw, this.file),
    );
    if (set.isErr()) return err(set.error);

    const results: DriftResult[] = [];
    const claims: Claim[] = [];
    for (const claim of set.value.claims) {
      const e = claim.evidence;
      if (claim.status !== "verified" || !e) {
        claims.push(claim);
        continue;
      }
      const cites = `${e.path}:${e.line}`;
      const code = await this.fs.read(e.path);
      if (code.isErr()) {
        results.push({ id: claim.id, source: claim.source, status: "missing-file", cites });
        claims.push(claim);
        continue;
      }
      const match = locateQuote(code.value, e.line, e.quote);
      if (match.status === "stale")
        results.push({ id: claim.id, source: claim.source, status: "stale", cites });
      else
        results.push({ id: claim.id, source: claim.source, status: match.status, cites, line: match.line });
      claims.push(
        match.status === "moved" && input.fix ? { ...claim, evidence: { ...e, line: match.line } } : claim,
      );
    }
    if (input.fix && results.some((r) => r.status === "moved")) {
      const saved = await this.fs.write(this.file, serializeJsonDocument(ClaimSetDocument.stamp({ claims })));
      if (saved.isErr()) return err(saved.error);
    }
    return ok({ file: this.file, checked: results.length, results });
  }
}
