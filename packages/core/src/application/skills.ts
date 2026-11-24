import { GENERATED_MARKER, withMetatorCommand } from "../domain/agent.ts";
import type { MetatorConfig } from "../domain/config.ts";
import type { MetatorError } from "../domain/errors.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { frontMatterRule, lintSkill, type Skill, SkillDocument, type SkillRuleId } from "../domain/skill.ts";
import type { FileSystem, GeneratedFile, ReadonlyFileSystem, SkillGenerator } from "../ports/index.ts";
import type { GenerateReport } from "./agents.ts";
import { scanDocuments } from "./document-io.ts";
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
    // A file that cannot be read is left out, not reported: only what was read can be wrong.
    const { entries, problems } = await scanDocuments(
      this.fs,
      [`${this.paths.skills}/*/SKILL.md`],
      SkillDocument,
      { format: "front-matter", unreadable: "skip" },
    );
    const skills = entries.map(
      ({ value, source, text }): SkillEntry => ({
        skill: value,
        body: text.replace(/^---\n[\s\S]*?\n---\n/, ""),
        source,
        dir: source.slice(0, -"/SKILL.md".length),
      }),
    );
    return { skills, problems };
  }
}

export interface SkillProblem {
  readonly source: string;
  readonly skill?: string;
  /** The canon rule it breaks (`docs/metator/rules/skill.yml`); the message starts with it too. */
  readonly rule: SkillRuleId;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/**
 * `meta skills-lint` (04-commands §I): every canonical skill against the rules MT-SKILL-001..005
 * (name, description, body, supporting files, skills it names). A front matter that does not
 * parse breaks the rule of the field it gets wrong.
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
    const problems: SkillProblem[] = scan.problems.map((p) => {
      const issues = p.error.details?.issues as readonly { readonly path?: string }[] | undefined;
      const rule = frontMatterRule(issues?.[0]?.path);
      return { source: p.source, rule, severity: "error", message: `[${rule}] ${p.error.message}` };
    });
    // A skill whose front matter is broken is still a skill of the canon: naming it is no new problem.
    const skills = new Set([
      ...scan.skills.map((s) => s.skill.name),
      ...scan.problems.map((p) => p.source.split("/").slice(-2)[0] as string),
    ]);
    for (const { skill, body, source, dir } of scan.skills) {
      const files = new Map<string, string | undefined>();
      for (const f of skill.files) {
        const path = `${dir}/${f}`;
        const text = (await this.fs.exists(path)) ? await this.fs.read(path) : undefined;
        files.set(f, text === undefined ? undefined : text.isOk() ? text.value : "");
      }
      const dirName = dir.split("/").pop() as string;
      for (const finding of lintSkill(skill, body, { prefix: this.prefix, dir: dirName, files, skills }))
        problems.push({ source, skill: skill.name, severity: "error", ...finding });
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
