import { CONFIG_FILES, type MetatorConfig, MetatorConfigDocument } from "../domain/config.ts";
import { MetatorError } from "../domain/errors.ts";
import { type McpServers, mergeMcpServers } from "../domain/mcp.ts";
import { OPTIONS, optionByKey } from "../domain/option-registry.ts";
import {
  EXPERIMENTAL_PREFIX,
  experimentalOption,
  type OptionDefinition,
  type OptionDiagnostic,
  type OptionLayer,
  type OptionScope,
  optionGroup,
  optionsJsonSchema,
  type ResolvedOption,
  resolveOptions,
  showValue,
  UserOptionsDocument,
} from "../domain/options.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  parseJsonDocument,
  parseYamlDocument,
  renderYamlDocument,
  serializeJsonDocument,
  updateYamlPath,
} from "../domain/versioned.ts";
import type { FileSystem, UserConfigStore } from "../ports/index.ts";
import type { RunRepository } from "./run-repository.ts";

/** The person's options file, in the user config directory. */
export const USER_OPTIONS_FILE = "options.yml";

export interface OptionStoreDependencies {
  readonly fs: FileSystem;
  readonly user: UserConfigStore;
  /** The repository's config as loaded (its legacy fields and its `options:` map). */
  readonly config: MetatorConfig;
  /** Where the repository's config was read from (for diagnostics); none when defaults apply. */
  readonly configFile?: string | undefined;
  readonly runs?: RunRepository;
  readonly definitions?: readonly OptionDefinition[];
}

export interface OptionsView {
  readonly options: readonly ResolvedOption[];
  readonly diagnostics: readonly OptionDiagnostic[];
  /** The groups in order, each with how many options it has and how many are not at their default. */
  readonly groups: readonly { readonly id: string; readonly count: number; readonly changed: number }[];
  readonly files: { readonly user: string; readonly repo: string; readonly run?: string };
}

/**
 * Resolves, lists and sets options (S1): the user file, the repository's `options:` and a run's
 * overrides laid over the defaults. A set writes the file of the scope and returns the new view.
 */
export class OptionStore {
  private readonly definitions: readonly OptionDefinition[];

  constructor(private readonly deps: OptionStoreDependencies) {
    this.definitions = deps.definitions ?? OPTIONS;
  }

  /** Every option with its effective value and source; `changed` keeps only the ones a file sets. */
  async list(
    input: { readonly runId?: string; readonly scope?: OptionScope; readonly changed?: boolean } = {},
  ): Promise<Result<OptionsView, MetatorError>> {
    const layers = await this.layers(input.runId);
    if (layers.isErr()) return err(layers.error);
    const { options, diagnostics } = resolveOptions(
      this.definitions,
      layers.value.layers,
      layers.value.config,
    );
    const kept = options.filter(
      (o) =>
        (!input.scope || o.definition.scope === input.scope) && (!input.changed || o.source !== "default"),
    );
    const groups = new Map<string, { id: string; count: number; changed: number }>();
    for (const o of options) {
      const g = optionGroup(o.key);
      const entry = groups.get(g) ?? { id: g, count: 0, changed: 0 };
      entry.count += 1;
      if (o.source !== "default") entry.changed += 1;
      groups.set(g, entry);
    }
    return ok({
      options: kept,
      diagnostics: [...layers.value.diagnostics, ...diagnostics],
      groups: [...groups.values()],
      files: {
        user: USER_OPTIONS_FILE,
        repo: this.deps.configFile ?? "metator.config.yml",
        ...(input.runId ? { run: `${input.runId}/state.json` } : {}),
      },
    });
  }

  async get(
    key: string,
    input: { readonly runId?: string } = {},
  ): Promise<Result<ResolvedOption, MetatorError>> {
    const view = await this.list(input);
    if (view.isErr()) return err(view.error);
    const found = view.value.options.find((o) => o.key === key);
    return found ? ok(found) : err(unknownOption(key));
  }

  /**
   * Sets a value at a scope; `text` is parsed as a person types it, `value` is taken as is (the
   * app). The file of the scope is written (the user file is created; the repository's config
   * keeps its comments; a run's record gets `options`).
   */
  async set(input: {
    readonly key: string;
    readonly scope: OptionScope;
    readonly text?: string;
    readonly value?: unknown;
    readonly runId?: string;
  }): Promise<Result<ResolvedOption, MetatorError>> {
    const def = this.definition(input.key);
    if (!def) return err(unknownOption(input.key));
    if (def.fixed)
      return err(
        MetatorError.usage(`${def.key} is fixed to ${showValue(def.defaultValue)} and cannot be set`),
      );
    if (!def.settableAt.includes(input.scope))
      return err(
        MetatorError.usage(
          `${def.key} is a ${def.scope} option; set it with --scope ${def.settableAt.join(" or ")}`,
        ),
      );
    const parsed = input.text !== undefined ? def.parseText(input.text) : def.parse(input.value);
    if (!parsed.ok) return err(MetatorError.usage(`${def.key}: ${parsed.message}`));
    const written = await this.write(input.scope, def.key, parsed.value, input.runId);
    if (written.isErr()) return err(written.error);
    return this.get(def.key, { ...(input.runId ? { runId: input.runId } : {}) });
  }

  /** Removes the value a scope holds, so the next layer down (or the default) applies again. */
  async unset(input: {
    readonly key: string;
    readonly scope: OptionScope;
    readonly runId?: string;
  }): Promise<Result<ResolvedOption, MetatorError>> {
    const def = this.definition(input.key);
    if (!def) return err(unknownOption(input.key));
    // Nothing to remove: no file is written (or created) for a key the scope does not hold.
    const layers = await this.layers(input.runId);
    if (layers.isErr()) return err(layers.error);
    const held = layers.value.layers.some((l) => l.scope === input.scope && def.key in l.values);
    if (!held) return this.get(def.key, { ...(input.runId ? { runId: input.runId } : {}) });
    const written = await this.write(input.scope, def.key, undefined, input.runId);
    if (written.isErr()) return err(written.error);
    return this.get(def.key, { ...(input.runId ? { runId: input.runId } : {}) });
  }

  /** JSON Schema of the options map, one property per option. */
  schema(): Record<string, unknown> {
    return optionsJsonSchema(this.definitions);
  }

  private definition(key: string): OptionDefinition | undefined {
    return (
      this.definitions.find((d) => d.key === key) ??
      (this.definitions === OPTIONS ? optionByKey(key) : undefined) ??
      (key.startsWith(EXPERIMENTAL_PREFIX) && key.length > EXPERIMENTAL_PREFIX.length
        ? experimentalOption(key)
        : undefined)
    );
  }

  /** The three layers as the files hold them; a file that does not parse is a diagnostic and an empty layer. */
  /**
   * The repository's config as the file holds it now (a set a moment ago is visible at once); the
   * loaded config when there is no file, or when the file does not parse (then a diagnostic too).
   */
  private async repoConfig(): Promise<{
    config: MetatorConfig;
    source: string;
    diagnostic?: OptionDiagnostic;
  }> {
    for (const file of CONFIG_FILES) {
      if (!(await this.deps.fs.exists(file))) continue;
      const text = await this.deps.fs.read(file);
      if (text.isErr()) break;
      const parsed = (
        file.endsWith(".json") ? parseJsonDocument(text.value, file) : parseYamlDocument(text.value, file)
      ).andThen((raw) => MetatorConfigDocument.parse(raw, file));
      if (parsed.isOk()) return { config: parsed.value, source: file };
      return {
        config: this.deps.config,
        source: file,
        diagnostic: {
          kind: "invalid-value",
          scope: "repo",
          source: file,
          key: "",
          message: `${parsed.error.message}; the loaded config applies`,
        },
      };
    }
    return { config: this.deps.config, source: this.deps.configFile ?? "metator.config.yml" };
  }

  /**
   * The repository's own MCP servers (`mcp:` in its config): what a committed file such as
   * `.mcp.json` may hold. A person's servers never go there: they are theirs, not the team's.
   */
  async repoMcp(): Promise<Result<McpServers, MetatorError>> {
    return ok((await this.repoConfig()).config.mcp);
  }

  /**
   * The MCP servers MetatorAI itself uses in this repository (intake, reviews, doctor): the
   * repository's, the person's own over them (T1).
   */
  async mcp(): Promise<Result<McpServers, MetatorError>> {
    const user = await this.deps.user.read(USER_OPTIONS_FILE);
    if (user.isErr()) return err(user.error);
    let mine: McpServers = {};
    if (user.value !== undefined) {
      const parsed = parseYamlDocument(user.value, USER_OPTIONS_FILE).andThen((raw) =>
        UserOptionsDocument.parse(raw, USER_OPTIONS_FILE),
      );
      if (parsed.isOk()) mine = parsed.value.mcp;
    }
    return (await this.repoMcp()).map((repo) => mergeMcpServers(repo, mine));
  }

  private async layers(
    runId?: string,
  ): Promise<
    Result<{ layers: OptionLayer[]; diagnostics: OptionDiagnostic[]; config: MetatorConfig }, MetatorError>
  > {
    const layers: OptionLayer[] = [];
    const diagnostics: OptionDiagnostic[] = [];
    const user = await this.deps.user.read(USER_OPTIONS_FILE);
    if (user.isErr()) return err(user.error);
    if (user.value !== undefined) {
      const parsed = parseYamlDocument(user.value, USER_OPTIONS_FILE).andThen((raw) =>
        UserOptionsDocument.parse(raw, USER_OPTIONS_FILE),
      );
      if (parsed.isOk())
        layers.push({ scope: "user", source: USER_OPTIONS_FILE, values: parsed.value.options });
      else
        diagnostics.push({
          kind: "invalid-value",
          scope: "user",
          source: USER_OPTIONS_FILE,
          key: "",
          message: `${parsed.error.message}; the file is ignored`,
        });
    }
    const repo = await this.repoConfig();
    if (repo.diagnostic) diagnostics.push(repo.diagnostic);
    layers.push({ scope: "repo", source: repo.source, values: repo.config.options });
    if (runId && this.deps.runs) {
      const record = await this.deps.runs.load(runId);
      if (record.isErr()) return err(record.error);
      layers.push({ scope: "run", source: `${runId}/state.json`, values: record.value.options ?? {} });
    }
    return ok({ layers, diagnostics, config: repo.config });
  }

  private async write(
    scope: OptionScope,
    key: string,
    value: unknown,
    runId?: string,
  ): Promise<Result<void, MetatorError>> {
    if (scope === "user") return this.writeUser(key, value);
    if (scope === "repo") return this.writeRepo(key, value);
    if (!runId || !this.deps.runs) return err(MetatorError.usage("a run-scope option needs --run <id>"));
    const saved = await this.deps.runs.update(runId, (record) => {
      const options = { ...(record.options ?? {}) };
      if (value === undefined) delete options[key];
      else options[key] = value;
      return ok({ ...record, options });
    });
    return saved.map(() => undefined);
  }

  private async writeUser(key: string, value: unknown): Promise<Result<void, MetatorError>> {
    const current = await this.deps.user.read(USER_OPTIONS_FILE);
    if (current.isErr()) return err(current.error);
    // A fresh file carries the header only, so the map `setIn` creates is a block map, one key per line.
    const text =
      current.value ??
      renderYamlDocument(
        { kind: UserOptionsDocument.kind, schemaVersion: UserOptionsDocument.current },
        "Your MetatorAI options (`metator config set <key> <value>`); a wrong value is a warning, not an error.",
      );
    return this.deps.user.write(USER_OPTIONS_FILE, updateYamlPath(text, ["options", key], value));
  }

  private async writeRepo(key: string, value: unknown): Promise<Result<void, MetatorError>> {
    let file: string | undefined;
    for (const f of CONFIG_FILES) if (await this.deps.fs.exists(f)) file = file ?? f;
    if (!file) {
      const text = renderYamlDocument(
        {
          kind: MetatorConfigDocument.kind,
          schemaVersion: MetatorConfigDocument.current,
          options: value === undefined ? {} : { [key]: value },
        },
        "Written by `metator config set`; every other setting keeps its default.",
      );
      return this.deps.fs.write("metator.config.yml", text);
    }
    const text = await this.deps.fs.read(file);
    if (text.isErr()) return err(text.error);
    const json = file.endsWith(".json");
    let next: string;
    if (json) {
      const raw = parseJsonDocument(text.value, file);
      if (raw.isErr()) return err(raw.error);
      const doc = raw.value as Record<string, unknown>;
      const options = { ...((doc.options as Record<string, unknown> | undefined) ?? {}) };
      if (value === undefined) delete options[key];
      else options[key] = value;
      next = serializeJsonDocument({ ...doc, schemaVersion: MetatorConfigDocument.current, options });
    } else {
      next = updateYamlPath(
        updateYamlPath(text.value, ["schemaVersion"], MetatorConfigDocument.current),
        ["options", key],
        value,
      );
    }
    // The file must still be a valid config before it is written.
    const after = (json ? parseJsonDocument(next, file) : parseYamlDocument(next, file)).andThen((raw) =>
      MetatorConfigDocument.parse(raw, file),
    );
    if (after.isErr()) return err(after.error);
    return this.deps.fs.write(file, next);
  }
}

const unknownOption = (key: string): MetatorError =>
  MetatorError.notFound(`option ${key}`, { hint: "`metator config list` shows every option." });
