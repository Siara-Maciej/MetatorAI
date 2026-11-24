---
kind: Skill
schemaVersion: 1
name: mt-read-java
description: Reads facts about Java code from the `metator java` command that measures them (types, endpoints, entities, beans and their wiring, configuration keys, entry points, Maven or Gradle modules) and cites each with its path:line evidence. Use when a question or a task needs facts about a Java repository. Do not use for TypeScript code or to change Java code; it only reads.
---
# When
The repository (or one beside it, `-C <repo>`) has a `pom.xml` or a Gradle build and you must say what its Java code does: which endpoints exist, what an entity relates to, which bean is injected where, which keys configure it, what runs on its own. A command measures; you decide. Never answer such a question from grep output alone.

# Steps
1. Start with `metator java overview`: build tools, modules, Java versions, source roots, counts, frameworks with evidence, and `parseFailures` (files it could not read; everything else was read).
2. Pick the command for the question. Every list takes `--module <name>` and `--package <prefix>`:

| Question | Command |
|---|---|
| Modules, their parents, what each depends on (other modules, `group:artifact:version` with scope) | `metator java modules` |
| Which types; of a kind; carrying an annotation; implementing an interface | `metator java types [--kind class\|interface\|enum\|record\|annotation] [--annotated <Name>] [--implements <Type>]` |
| One type in full: members, annotations, supertypes, subtypes, who uses it, its roles | `metator java show <Type>` (a fully qualified name, or a simple name that is unique) |
| HTTP endpoints: method, joined path, handler, parameters, request and response types | `metator java endpoints [--framework spring-mvc\|webflux\|jax-rs\|servlet]` |
| JPA entities, columns, ids, relations, inheritance, `persistence.xml` units | `metator java entities` |
| Spring Data repositories, their entity, derived and `@Query` methods | `metator java repositories` |
| Beans (Spring, `@Bean` methods, XML, CDI, EJB) and their injection points; who injects a type | `metator java beans [--injects <Type>]` |
| Configuration keys by profile, and where code reads them (`@Value`, `@ConfigurationProperties`) | `metator java config [--key <prefix>]` |
| What runs by itself: `main`, `@Scheduled`, Kafka/JMS/Rabbit listeners, `@EventListener`, message-driven beans | `metator java entrypoints` |
| Which files depend on a `.java` file, the tests a change reaches, where a type is declared | `metator graph dependents <file> --transitive`, `metator graph affected --files <files>`, `metator symbols find <Name>` |

3. `metator java show` says `AMBIGUOUS` with `details.candidates`: run it again with the fully qualified name you mean. `NOT_FOUND`: the type is not in the repository (a JDK or library type), say so.
4. The index is a cache under `.metator/` rebuilt by itself when files change; `metator java index --check` says whether it is current. You never need to build it first.
5. Read the cited lines (`at`, `evidence[].at`) before you build on a fact that matters to the task.

# Output
Facts with their evidence: each claim names the `path:line` the command gave (`at` or `evidence[].at`) and, for a fact marked `likely`, says it is likely and why (`evidence[].source`). For example:

> `GET /api/orders/{id}` is handled by `OrderController#get` (shop-api/src/main/java/com/example/shop/api/OrderController.java:32). `/api/customers/{id}` is likely: its path is built from the constant `ApiPaths.CUSTOMERS` (CustomerController.java:13), which reads `/api/customers` (ApiPaths.java:4).

# Checklist
- [ ] every fact comes from a `metator java` (or `graph`, `symbols`) command, cited as `path:line`
- [ ] `confidence: "likely"` is reported as likely: a path built from a constant, a RouterFunction route, an injection with several candidates (`candidates` > 1, no `provider`)
- [ ] `parseFailures` from the overview are named when the answer could depend on those files
- [ ] `--module`/`--package` narrowed a large repository before the whole list was read

# Errors
An overview with no `buildTools` and no files: this repository has no Java; for a Java repository beside this one, add `-C <its path>`. A command that fails: report its message (and its `hint`) and stop; do not fall back to guessing from text search.
