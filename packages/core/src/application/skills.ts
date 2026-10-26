import { GENERATED_MARKER, withMetatorCommand } from "../domain/agent.ts";
import type { MetatorConfig } from "../domain/config.ts";
import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  ANTI_TRIGGER,
  referencedFiles,
  SKILL_BODY_LINES,
  SKILL_SECTIONS,
  type Skill,
  SkillDocument,
  TRIGGER,
} from "../domain/skill.ts";
import { readFrontMatter } from "../domain/versioned.ts";
import type { FileSystem, GeneratedFile, ReadonlyFileSystem, SkillGenerator } from "../ports/index.ts";
import type { GenerateReport } from "./agents.ts";
import type { MetatorPaths } from "./paths.ts";

export interface SkillEntry {
  readonly skill: Skill;
  readonly body: string;
  /** `metator/skills/<dir>/SKILL.md` */
  readonly source: string;
  readonly dir: string;
}

/** Canonical skills: every `<paths.skills>/<dir>/SKILL.md` with a `Skill` front matter. */
export class SkillCatalog {
  constructor(
    private readonly fs: ReadonlyFileSystem,
    private readonly paths: MetatorPaths,
  ) {}

  async scan(): Promise<{
    readonly skills: readonly SkillEntry[];
    readonly problems: readonly { readonly source: string; readonly error: MetatorError }[];
  }> {
    const skills: SkillEntry[] = [];
    const problems: { source: string; error: MetatorError }[] = [];
    for (const source of [...(await this.fs.glob([`${this.paths.skills}/*/SKILL.md`]))].sort()) {
      const text = await this.fs.read(source);
      if (text.isErr()) continue;
      const skill = readFrontMatter(text.value, source).andThen((raw) => SkillDocument.parse(raw, source));
      if (skill.isErr()) problems.push({ source, error: skill.error });
      else
        skills.push({
          skill: skill.value,
          body: text.value.replace(/^---\n[\s\S]*?\n---\n/, ""),
          source,
          dir: source.slice(0, -"/SKILL.md".length),
        });
    }
    return { skills, problems };
  }
}

export interface SkillProblem {
  readonly source: string;
  readonly skill?: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/**
 * `meta skills-lint` (04-commands §I): name = directory and prefix, a description with a trigger
 * and an anti-trigger, the template's sections, ≤ 300 lines, and every file it uses exists.
 */
export class LintSkills {
  constructor(
    private readonly catalog: SkillCatalog,
    private readonly fs: ReadonlyFileSystem,
    private readonly prefix: string,
  ) {}

  async execute(): Promise<
    Result<{ readonly skills: number; readonly problems: readonly SkillProblem[] }, MetatorError>
  > {
    const scan = await this.catalog.scan();
    const problems: SkillProblem[] = scan.problems.map((p) => ({
      source: p.source,
      severity: "error",
      message: p.error.message,
    }));
    for (const { skill, body, source, dir } of scan.skills) {
      const error = (message: string) =>
        problems.push({ source, skill: skill.name, severity: "error", message });
      if (dir.split("/").pop() !== skill.name)
        error(`name must match its directory (${dir.split("/").pop()})`);
      if (!skill.name.startsWith(this.prefix)) error(`name must start with "${this.prefix}"`);
      if (!TRIGGER.test(skill.description)) error('description must say when to use it ("Use when …")');
      if (!ANTI_TRIGGER.test(skill.description))
        error('description must say when not to use it ("Do not use …")');
      const headings = [...body.matchAll(/^#{1,2}\s+(.+?)\s*$/gm)].map((m) => (m[1] as string).toLowerCase());
      for (const names of SKILL_SECTIONS)
        if (!names.some((n) => headings.includes(n.toLowerCase())))
          error(`missing section "# ${names.join('" or "# ')}"`);
      const lines = body.trimEnd().split("\n").length;
      if (lines > SKILL_BODY_LINES) error(`body has ${lines} lines, the budget is ${SKILL_BODY_LINES}`);
      for (const f of skill.files)
        if (!(await this.fs.exists(`${dir}/${f}`))) error(`file ${f} does not exist`);
      for (const f of referencedFiles(body))
        if (!skill.files.includes(f)) error(`uses ${f}; list it in files (and ship it next to SKILL.md)`);
    }
    return ok({ skills: scan.skills.length, problems });
  }
}

/** `metator generate` for skills: each host's skill directories from the canon (ADR-0039). */
export class GenerateSkills {
  constructor(
    private readonly catalog: SkillCatalog,
    private readonly generators: readonly SkillGenerator[],
    private readonly fs: FileSystem,
    private readonly config: MetatorConfig,
  ) {}

  async execute(input: { readonly check: boolean }): Promise<Result<GenerateReport, MetatorError>> {
    const scan = await this.catalog.scan();
    if (scan.problems.length > 0) return err(scan.problems[0]?.error as MetatorError);
    const hosts = this.generators.filter((g) => this.config.hosts.targets.includes(g.host));
    const expected = new Map<string, string>();
    for (const { skill, body, source, dir } of scan.skills) {
      const files: GeneratedFile[] = [];
      for (const f of skill.files) {
        const text = await this.fs.read(`${dir}/${f}`);
        if (text.isErr()) return err(text.error);
        files.push({ path: f, content: text.value });
      }
      const text = withMetatorCommand(body, this.config.hosts.metatorCommand);
      for (const g of hosts)
        for (const file of g.skill(skill, text, files, {
          source,
          metatorCommand: this.config.hosts.metatorCommand,
        }))
          expected.set(file.path, file.content);
    }

    const written: string[] = [];
    const unchanged: string[] = [];
    const stale: string[] = [];
    for (const [path, content] of [...expected].sort(([a], [b]) => a.localeCompare(b))) {
      const current = await this.fs.read(path);
      if (current.isOk() && current.value === content) unchanged.push(path);
      else if (input.check) stale.push(path);
      else {
        const saved = await this.fs.write(path, content);
        if (saved.isErr()) return err(saved.error);
        written.push(path);
      }
    }
    // A generated skill directory whose canonical skill is gone, or a file it no longer ships.
    const orphaned: string[] = [];
    for (const g of hosts) {
      for (const skillFile of await this.fs.glob([g.owns])) {
        const text = await this.fs.read(skillFile);
        if (!text.isOk() || !text.value.includes(GENERATED_MARKER)) continue;
        const dir = skillFile.slice(0, -"/SKILL.md".length);
        for (const path of await this.fs.glob([`${dir}/**`])) if (!expected.has(path)) orphaned.push(path);
      }
    }
    return ok({ written, unchanged, stale, orphaned: orphaned.sort() });
  }
}
