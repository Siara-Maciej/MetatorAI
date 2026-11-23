import { JAVA_TYPE_KINDS, type JavaTypeKind, type JavaWebFramework } from "@metator/core";
import { type Command, Option } from "commander";
import { meta } from "../command-meta.ts";
import type { CommandContext } from "../context.ts";
import {
  renderJavaBeans,
  renderJavaConfig,
  renderJavaEndpoints,
  renderJavaEntities,
  renderJavaEntrypoints,
  renderJavaIndex,
  renderJavaModules,
  renderJavaOverview,
  renderJavaRepositories,
  renderJavaShow,
  renderJavaTypes,
} from "../java-render.ts";

interface Scope {
  readonly module?: string;
  readonly package?: string;
}

/** `--module` and `--package`: what every list command filters by. */
const scoped = (cmd: Command): Command =>
  cmd
    .option("--module <name>", "only this Maven/Gradle module")
    .option("--package <prefix>", "only this Java package and the ones below it (com.example.shop)");

const scopeOf = (o: Scope): Scope => ({
  ...(o.module ? { module: o.module } : {}),
  ...(o.package ? { package: o.package } : {}),
});

const FRAMEWORKS: readonly JavaWebFramework[] = ["spring-mvc", "webflux", "jax-rs", "servlet"];

/**
 * `metator java`: deterministic reading of a Java repository (ADR-0107). Maven and Gradle
 * modules, every type with its members and annotations, endpoints, JPA entities, Spring Data
 * repositories, beans and their wiring, configuration keys and where code reads them, entry
 * points; each fact with the `path:line` that shows it. Nothing runs a JDK or the build.
 */
export function registerJavaCommands(program: Command, { action, container }: CommandContext): void {
  const java = meta(program.command("java"), { reads: true }).description(
    "Read a Java repository: modules, types, endpoints, entities, beans, configuration, entry points",
  );
  const read = () => container().resolve("readJava");

  meta(java.command("overview"), { audience: "person", typed: true, render: renderJavaOverview })
    .description(
      "Build tools, modules, Java versions, source roots, counts, frameworks and files that did not parse",
    )
    .action(action(async () => ({ result: await read().overview() })));

  meta(scoped(java.command("modules")), { render: renderJavaModules })
    .description("Each module: directory, packaging, parent, dependencies on other modules and external ones")
    .action(action(async (o: Scope) => ({ result: await read().modules(scopeOf(o)) })));

  meta(scoped(java.command("types")), { typed: true, render: renderJavaTypes })
    .description("The types, one line each")
    .addOption(new Option("--kind <kind>", "only this kind").choices([...JAVA_TYPE_KINDS]))
    .option("--annotated <name>", "only types with this annotation (Entity, @RestController)")
    .option("--implements <type>", "only types that extend or implement this type (simple or qualified)")
    .action(
      action(async (o: Scope & { kind?: JavaTypeKind; annotated?: string; implements?: string }) => ({
        result: await read().types({
          ...scopeOf(o),
          ...(o.kind ? { kind: o.kind } : {}),
          ...(o.annotated ? { annotated: o.annotated } : {}),
          ...(o.implements ? { implements: o.implements } : {}),
        }),
      })),
    );

  meta(java.command("show"), { typed: true, render: renderJavaShow })
    .description("One type in full: members, annotations, supertypes and subtypes, where it is used")
    .argument("<type>", "a fully qualified name, or a simple name only one type has")
    .action(action(async (type: string) => ({ result: await read().show(type) })));

  meta(scoped(java.command("endpoints")), { typed: true, render: renderJavaEndpoints })
    .description("HTTP endpoints: Spring MVC, WebFlux (annotations and RouterFunction), JAX-RS, Servlets")
    .addOption(new Option("--framework <name>", "only this framework").choices([...FRAMEWORKS]))
    .action(
      action(async (o: Scope & { framework?: JavaWebFramework }) => ({
        result: await read().endpoints({ ...scopeOf(o), ...(o.framework ? { framework: o.framework } : {}) }),
      })),
    );

  meta(scoped(java.command("entities")), { render: renderJavaEntities })
    .description(
      "JPA entities (javax and jakarta) with ids, columns and relations, and persistence.xml units",
    )
    .action(action(async (o: Scope) => ({ result: await read().entities(scopeOf(o)) })));

  meta(scoped(java.command("repositories")), { render: renderJavaRepositories })
    .description("Spring Data repositories: entity, id, derived query methods and @Query strings")
    .action(action(async (o: Scope) => ({ result: await read().repositories(scopeOf(o)) })));

  meta(scoped(java.command("beans")), { typed: true, render: renderJavaBeans })
    .description(
      "Spring, CDI, EJB and Spring XML beans with their injection points and the bean that provides each",
    )
    .option("--injects <type>", "only beans that inject this type (simple or qualified)")
    .action(
      action(async (o: Scope & { injects?: string }) => ({
        result: await read().beans({ ...scopeOf(o), ...(o.injects ? { injects: o.injects } : {}) }),
      })),
    );

  meta(scoped(java.command("config")), { render: renderJavaConfig })
    .description(
      "application*.properties/yml keys by profile, and where code reads them (@Value, @ConfigurationProperties)",
    )
    .option("--key <prefix>", "only keys under this prefix (shop.orders)")
    .action(
      action(async (o: Scope & { key?: string }) => ({
        result: await read().config({ ...scopeOf(o), ...(o.key ? { key: o.key } : {}) }),
      })),
    );

  meta(scoped(java.command("entrypoints")), { render: renderJavaEntrypoints })
    .description(
      "main methods, @Scheduled jobs, Kafka/JMS/Rabbit and event listeners, message-driven and startup beans",
    )
    .action(action(async (o: Scope) => ({ result: await read().entrypoints(scopeOf(o)) })));

  meta(java.command("index"), { render: renderJavaIndex })
    .description(
      "Build or refresh the Java index (.metator/index/java.json); --check only says whether it is current",
    )
    .option("--check", "change nothing; exit 65 (STALE_INDEX) when the index is not current")
    .action(
      action(async (o: { check?: boolean }) => ({ result: await read().index({ check: o.check === true }) })),
    );
}
