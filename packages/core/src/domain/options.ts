import { z } from "zod";
import type { MetatorConfig } from "./config.ts";
import { McpServersSchema } from "./mcp.ts";
import { defineDocument } from "./versioned.ts";

/**
 * Options (S1, design/13): one definition per setting, in one registry, with a type, a default, a
 * description and the scope it may be set at. Every surface (CLI, daemon, app) answers "what is
 * the value here" the same way: the layers are laid over the default, a bad value is a diagnostic
 * and the default, never a failure.
 */
export const OPTION_SCOPES = ["user", "repo", "run"] as const;
export type OptionScope = (typeof OPTION_SCOPES)[number];
/** Where a value comes from: a scope's file, or the definition's default. */
export type OptionSource = OptionScope | "default";
export type OptionRestart = "none" | "daemon" | "app";
export type OptionKind = "boolean" | "enum" | "number" | "string" | "list" | "keybinding" | "command";

export interface OptionSpec<T> {
  /** Dotted, lower camel: `ui.paneBorders`, `keys.zoom`. */
  readonly key: string;
  /** The scope the option belongs to: `user` options are a person's, `repo` options the repository's (a run may override those). */
  readonly scope: Exclude<OptionScope, "run">;
  readonly title: string;
  readonly description: string;
  readonly defaultValue: T;
  readonly restart?: OptionRestart;
  /** The phase that introduced it. */
  readonly since?: string;
  /** A field of `metator.config` older than the option system that still sets it (read, never written). */
  readonly legacy?: (config: MetatorConfig) => unknown;
  /** Shown, never changed (a guarantee of the product, e.g. `issues.requireConsent`). */
  readonly fixed?: boolean;
}

/** What a client needs to show and edit an option, without the zod schema. */
export interface OptionDescription {
  readonly key: string;
  readonly kind: OptionKind;
  readonly scope: Exclude<OptionScope, "run">;
  readonly title: string;
  readonly description: string;
  readonly default: unknown;
  readonly restart: OptionRestart;
  readonly since?: string;
  readonly fixed: boolean;
  readonly choices?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly unit?: string;
  /** A command option runs on the person's machine: clients say so next to it. */
  readonly runsLocally?: boolean;
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export abstract class OptionDefinition<T = unknown> {
  abstract readonly kind: OptionKind;
  abstract readonly schema: z.ZodType<T>;

  constructor(readonly spec: OptionSpec<T>) {}

  get key(): string {
    return this.spec.key;
  }
  get scope(): Exclude<OptionScope, "run"> {
    return this.spec.scope;
  }
  get defaultValue(): T {
    return this.spec.defaultValue;
  }
  get restart(): OptionRestart {
    return this.spec.restart ?? "none";
  }
  get fixed(): boolean {
    return this.spec.fixed === true;
  }
  /** The scopes a value may be set at: a user option at `user`; a repo option at `repo` and, per run, at `run`. */
  get settableAt(): readonly OptionScope[] {
    return this.scope === "user" ? ["user"] : ["repo", "run"];
  }

  /** A value as a file holds it (YAML/JSON), checked against the option's type. */
  parse(raw: unknown): Parsed<T> {
    const r = this.schema.safeParse(raw);
    return r.success ? { ok: true, value: r.data } : { ok: false, message: describe(r.error) };
  }

  /** A value as a person types it on the command line. */
  parseText(text: string): Parsed<T> {
    return this.parse(this.fromText(text));
  }

  /** How the option's kind reads a typed value (a string stays a string). */
  protected fromText(text: string): unknown {
    return text;
  }

  describe(): OptionDescription {
    return {
      key: this.key,
      kind: this.kind,
      scope: this.scope,
      title: this.spec.title,
      description: this.spec.description,
      default: this.defaultValue,
      restart: this.restart,
      ...(this.spec.since ? { since: this.spec.since } : {}),
      fixed: this.fixed,
      ...this.details(),
    };
  }

  /** Kind-specific fields of the description. */
  protected details(): Partial<OptionDescription> {
    return {};
  }
}

const describe = (error: z.ZodError): string => {
  const issue = error.issues[0];
  return issue ? issue.message : "invalid value";
};

export class BooleanOption extends OptionDefinition<boolean> {
  readonly kind = "boolean" as const;
  readonly schema = z.boolean();
  protected override fromText(text: string): unknown {
    const t = text.trim().toLowerCase();
    if (["true", "on", "yes", "1"].includes(t)) return true;
    if (["false", "off", "no", "0"].includes(t)) return false;
    return text;
  }
}

export class EnumOption<V extends string = string> extends OptionDefinition<V> {
  readonly kind = "enum" as const;
  readonly schema: z.ZodType<V>;
  constructor(
    spec: OptionSpec<V>,
    readonly choices: readonly [V, ...V[]],
  ) {
    super(spec);
    this.schema = z.enum(choices) as unknown as z.ZodType<V>;
  }
  protected override fromText(text: string): unknown {
    return text.trim();
  }
  protected override details(): Partial<OptionDescription> {
    return { choices: this.choices };
  }
}

export class NumberOption extends OptionDefinition<number> {
  readonly kind = "number" as const;
  readonly schema: z.ZodType<number>;
  constructor(
    spec: OptionSpec<number>,
    readonly range: {
      readonly min?: number;
      readonly max?: number;
      readonly integer?: boolean;
      readonly unit?: string;
    } = {},
  ) {
    super(spec);
    let s = range.integer === false ? z.number() : z.number().int();
    if (range.min !== undefined) s = s.min(range.min);
    if (range.max !== undefined) s = s.max(range.max);
    this.schema = s;
  }
  protected override fromText(text: string): unknown {
    const t = text.trim();
    return t === "" || Number.isNaN(Number(t)) ? text : Number(t);
  }
  protected override details(): Partial<OptionDescription> {
    return {
      ...(this.range.min !== undefined ? { min: this.range.min } : {}),
      ...(this.range.max !== undefined ? { max: this.range.max } : {}),
      ...(this.range.unit ? { unit: this.range.unit } : {}),
    };
  }
}

export class StringOption extends OptionDefinition<string> {
  readonly kind = "string" as const;
  readonly schema: z.ZodType<string>;
  constructor(spec: OptionSpec<string>, rules: { readonly allowEmpty?: boolean } = {}) {
    super(spec);
    this.schema = rules.allowEmpty ? z.string() : z.string().min(1, "expected a non-empty text");
  }
}

/** A list of texts; typed as `a, b, c`. */
export class ListOption extends OptionDefinition<readonly string[]> {
  readonly kind = "list" as const;
  readonly schema: z.ZodType<readonly string[]> = z.array(z.string().min(1));
  protected override fromText(text: string): unknown {
    return splitList(text);
  }
}

const splitList = (text: string): string[] =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/**
 * A key chord: modifiers joined with `+` before one key (`ctrl+b`, `prefix+z`,
 * `shift+enter`, `f5`, `[`). `prefix+` means "after the prefix chord".
 */
const KEY =
  /^(?:(?:ctrl|alt|shift|meta|prefix)\+)*(?:[a-z0-9]|f(?:[1-9]|1[0-2])|space|enter|escape|esc|tab|backspace|delete|up|down|left|right|home|end|pageup|pagedown|[[\]\\;'.,/=`?-])$/i;
export const isKeyChord = (text: string): boolean => KEY.test(text.trim());

/** One chord or several (any of them triggers); typed as `ctrl+b, ctrl+space`. */
export class KeybindingOption extends OptionDefinition<readonly string[]> {
  readonly kind = "keybinding" as const;
  readonly schema: z.ZodType<readonly string[]> = z
    .array(z.string().refine(isKeyChord, { message: "not a key: expected e.g. ctrl+b, prefix+z, f5" }))
    .min(1, "expected at least one key");
  /** A single chord in a file (`zoom: prefix+z`) is a list of one. */
  override parse(raw: unknown): Parsed<readonly string[]> {
    return super.parse(typeof raw === "string" ? splitList(raw) : raw);
  }
  protected override fromText(text: string): unknown {
    return splitList(text);
  }
}

/** A shell command run on the person's machine (an editor, a notifier). */
export class CommandOption extends OptionDefinition<string> {
  readonly kind = "command" as const;
  readonly schema: z.ZodType<string>;
  /** `allowEmpty`: an empty command means "none" (the option is off). */
  constructor(spec: OptionSpec<string>, rules: { readonly allowEmpty?: boolean } = {}) {
    super(spec);
    this.schema = rules.allowEmpty ? z.string() : z.string().min(1, "expected a command");
  }
  protected override details(): Partial<OptionDescription> {
    return { runsLocally: true };
  }
}

/** A client's view of one option's effective value. */
export interface ResolvedOption<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly source: OptionSource;
  readonly definition: OptionDescription;
  /** The values each scope holds for it (valid ones only), so a client shows what a reset would reveal. */
  readonly layers: Partial<Record<OptionScope, unknown>>;
}

export type OptionDiagnosticKind = "unknown-key" | "invalid-value" | "wrong-scope" | "fixed";

/** A problem in a layer: said, never thrown. The default (or the next layer down) applies. */
export interface OptionDiagnostic {
  readonly kind: OptionDiagnosticKind;
  readonly scope: OptionScope;
  /** The file the layer came from. */
  readonly source: string;
  readonly key: string;
  readonly message: string;
}

/** The values one scope holds, as read from its file, with the file's name for diagnostics. */
export interface OptionLayer {
  readonly scope: OptionScope;
  readonly source: string;
  readonly values: Readonly<Record<string, unknown>>;
}

const LAYER_ORDER: readonly OptionScope[] = ["user", "repo", "run"];

/** `experimental.<flag>`: a boolean option that exists because a file names it. */
export const EXPERIMENTAL_PREFIX = "experimental.";
export const experimentalOption = (key: string): BooleanOption =>
  new BooleanOption({
    key,
    scope: "user",
    title: key.slice(EXPERIMENTAL_PREFIX.length),
    description: "An experimental flag; it may go away without notice.",
    defaultValue: false,
    since: "S1",
  });

/**
 * Lays the layers over the defaults (and over the legacy config fields): user, then repo, then
 * run, each at the scopes it may set; the last valid value wins. Everything else is a diagnostic.
 */
export function resolveOptions(
  definitions: readonly OptionDefinition[],
  layers: readonly OptionLayer[],
  legacy?: MetatorConfig,
): { readonly options: readonly ResolvedOption[]; readonly diagnostics: readonly OptionDiagnostic[] } {
  const defs = new Map(definitions.map((d) => [d.key, d]));
  for (const layer of layers)
    for (const key of Object.keys(layer.values))
      if (!defs.has(key) && key.startsWith(EXPERIMENTAL_PREFIX)) defs.set(key, experimentalOption(key));
  const diagnostics: OptionDiagnostic[] = [];
  const ordered = [...layers].sort((a, b) => LAYER_ORDER.indexOf(a.scope) - LAYER_ORDER.indexOf(b.scope));
  const options = [...defs.values()].map((def): ResolvedOption => {
    let value: unknown = def.defaultValue;
    let source: OptionSource = "default";
    const fromLegacy = legacy && def.spec.legacy ? def.spec.legacy(legacy) : undefined;
    if (fromLegacy !== undefined) {
      const p = def.parse(fromLegacy);
      if (p.ok) {
        value = p.value;
        // A legacy field always has a value (its schema's default): only one that differs from
        // the option's default was set by the repository.
        if (!sameValue(p.value, def.defaultValue)) source = "repo";
      }
    }
    const held: Partial<Record<OptionScope, unknown>> = {};
    for (const layer of ordered) {
      if (!(def.key in layer.values)) continue;
      const raw = layer.values[def.key];
      if (def.fixed) {
        diagnostics.push(
          diag("fixed", layer, def.key, `${def.key} is fixed to ${showValue(def.defaultValue)}`),
        );
        continue;
      }
      if (!def.settableAt.includes(layer.scope)) {
        diagnostics.push(
          diag(
            "wrong-scope",
            layer,
            def.key,
            `${def.key} is a ${def.scope} option; it is set in ${def.settableAt.join(" or ")} scope`,
          ),
        );
        continue;
      }
      const p = def.parse(raw);
      if (!p.ok) {
        diagnostics.push(
          diag("invalid-value", layer, def.key, `${def.key}: ${p.message}; the default applies`),
        );
        continue;
      }
      held[layer.scope] = p.value;
      value = p.value;
      source = layer.scope;
    }
    return { key: def.key, value, source, definition: def.describe(), layers: held };
  });
  for (const layer of layers)
    for (const key of Object.keys(layer.values))
      if (!defs.has(key)) diagnostics.push(diag("unknown-key", layer, key, `unknown option ${key}`));
  return { options: options.sort((a, b) => a.key.localeCompare(b.key)), diagnostics };
}

const sameValue = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;

const diag = (
  kind: OptionDiagnosticKind,
  layer: OptionLayer,
  key: string,
  message: string,
): OptionDiagnostic => ({
  kind,
  scope: layer.scope,
  source: layer.source,
  key,
  message,
});

/** A value as a message shows it: lists joined, texts quoted, the rest as is. */
export const showValue = (value: unknown): string =>
  Array.isArray(value) ? value.join(", ") : typeof value === "string" ? `"${value}"` : String(value);

/** The group an option is shown under: its key's first segment (`ui`, `keys`, …). */
export const optionGroup = (key: string): string => key.split(".")[0] as string;

/**
 * `~/.config/metator/options.yml` (v1): a person's options, by key. Values are checked per key
 * when read, so an unknown key or a wrong value is a diagnostic, not an invalid document.
 */
const UserOptionsV1Schema = z.strictObject({
  options: z.record(z.string().min(1), z.unknown()).default({}),
});
/** v2 adds `mcp` (T1): the person's MCP servers, layered over the repository's by name. */
export const UserOptionsSchema = z.strictObject({
  ...UserOptionsV1Schema.shape,
  mcp: McpServersSchema,
});
export type UserOptions = z.output<typeof UserOptionsSchema>;
export const UserOptionsDocument = defineDocument("UserOptions", {
  history: [{ schema: UserOptionsV1Schema }],
  latest: UserOptionsSchema,
  upgrade: (v1) => v1,
  errorCode: "INVALID_CONFIG",
  hint: "The file holds `options:` with one entry per option key; `metator config list` shows the keys.",
});

/** JSON Schema of the `options:` map, one property per registered option (for editors and the app). */
export function optionsJsonSchema(definitions: readonly OptionDefinition[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const d of definitions) {
    const desc = d.describe();
    properties[d.key] = {
      ...z.toJSONSchema(d.schema, { io: "input" }),
      title: desc.title,
      description: desc.description,
      default: desc.default,
      "x-scope": desc.scope,
      ...(desc.restart !== "none" ? { "x-restart": desc.restart } : {}),
      ...(desc.fixed ? { readOnly: true } : {}),
    };
  }
  return { type: "object", properties, additionalProperties: false };
}
