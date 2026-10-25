import { MetatorError } from "@metator/core";

/** Typed DI token. The phantom `__type` keeps `resolve` type-safe without reflection. */
export type Token<T> = symbol & { readonly __type?: T };
export const token = <T>(description: string): Token<T> => Symbol(description) as Token<T>;

export type Factory<T> = (container: Container) => T;

/**
 * Minimal DI container: constructor injection via factories, lazy singletons,
 * explicit overrides (config > preset > default) and multi-bindings for registries.
 * Lazy by design so that hook entrypoints only construct what they touch.
 */
export class Container {
  private readonly single = new Map<symbol, Factory<unknown>>();
  private readonly multi = new Map<symbol, Factory<unknown>[]>();
  private readonly instances = new Map<symbol, unknown>();
  private readonly resolving: symbol[] = [];

  register<T>(t: Token<T>, factory: Factory<T>): this {
    if (this.single.has(t)) {
      throw new MetatorError("INTERNAL", `Duplicate binding for ${t.description}`, {
        hint: "Use override() to replace an existing binding.",
      });
    }
    this.single.set(t, factory);
    return this;
  }

  override<T>(t: Token<T>, factory: Factory<T>): this {
    this.single.set(t, factory);
    this.instances.delete(t);
    return this;
  }

  registerMany<T>(t: Token<T>, factory: Factory<T>): this {
    this.multi.set(t, [...(this.multi.get(t) ?? []), factory]);
    return this;
  }

  has(t: Token<unknown>): boolean {
    return this.single.has(t);
  }

  resolve<T>(t: Token<T>): T {
    if (this.instances.has(t)) return this.instances.get(t) as T;
    const factory = this.single.get(t);
    if (!factory) {
      throw new MetatorError("BINDING_MISSING", `No binding for ${t.description}`, {
        hint: "Enable the plugin that provides it or bind the capability in metator.config.",
      });
    }
    if (this.resolving.includes(t)) {
      const chain = [...this.resolving, t].map((s) => s.description).join(" -> ");
      throw new MetatorError("INTERNAL", `Dependency cycle: ${chain}`);
    }
    this.resolving.push(t);
    try {
      const instance = factory(this);
      this.instances.set(t, instance);
      return instance as T;
    } finally {
      this.resolving.pop();
    }
  }

  resolveAll<T>(t: Token<T>): T[] {
    return (this.multi.get(t) ?? []).map((factory) => factory(this) as T);
  }
}
