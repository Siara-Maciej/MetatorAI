import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  err,
  MetatorError,
  ok,
  type Result,
  type RuleScaffolder,
  type RuleScaffoldSpec,
} from "@metator/core";
import { parse, stringify } from "yaml";

/**
 * Writes a new ast-grep rule into the first `ruleDirs` entry of sgconfig.yml and its test into
 * the first `testConfigs` entry. The test starts with placeholder cases, so `ast-grep test`
 * fails until a person or agent writes real ones.
 */
export class AstGrepScaffolder implements RuleScaffolder {
  readonly engine = "ast-grep";

  constructor(private readonly root: string) {}

  async scaffold(
    spec: RuleScaffoldSpec,
  ): Promise<Result<{ readonly files: readonly string[] }, MetatorError>> {
    const configFile = join(this.root, "sgconfig.yml");
    if (!existsSync(configFile)) {
      return err(
        new MetatorError("NOT_FOUND", "sgconfig.yml not found", {
          hint: "Create sgconfig.yml with ruleDirs and testConfigs (see https://ast-grep.github.io/guide/project/project-config.html).",
        }),
      );
    }
    let config: { ruleDirs?: string[]; testConfigs?: { testDir: string }[] };
    try {
      config = (parse(await Bun.file(configFile).text()) ?? {}) as typeof config;
    } catch (e) {
      return err(new MetatorError("INVALID_CONFIG", `sgconfig.yml: ${(e as Error).message}`));
    }
    const ruleDir = config.ruleDirs?.[0];
    const testDir = config.testConfigs?.[0]?.testDir;
    if (!ruleDir || !testDir) {
      return err(new MetatorError("INVALID_CONFIG", "sgconfig.yml needs ruleDirs and testConfigs[].testDir"));
    }
    const ruleFile = `${ruleDir.replace(/\/$/, "")}/${spec.ruleId}.yml`;
    const testFile = `${testDir.replace(/\/$/, "")}/${spec.ruleId}-test.yml`;
    for (const f of [ruleFile, testFile]) {
      if (existsSync(join(this.root, f)))
        return err(MetatorError.usage(`${f} already exists`, "Edit it instead of scaffolding again."));
    }
    const rule = {
      id: spec.ruleId,
      language: "TypeScript",
      severity: "error",
      message: spec.message,
      ...(spec.files.length > 0 ? { files: [...spec.files] } : {}),
      rule: { pattern: "TODO_WRITE_THE_PATTERN($$$ARGS)" },
    };
    const test = {
      id: spec.ruleId,
      valid: ["// TODO: code that follows the rule"],
      invalid: ["// TODO: code that breaks the rule"],
    };
    await Bun.write(join(this.root, ruleFile), stringify(rule));
    await Bun.write(join(this.root, testFile), stringify(test));
    return ok({ files: [ruleFile, testFile] });
  }
}
