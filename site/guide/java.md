# Java repositories

MetatorAI works in a Java repository as it does in a TypeScript one: `metator setup` writes gates for its Maven or Gradle build, `metator doctor` checks the JDK, and the agents read the code through `metator java` commands that answer with the file and line of every fact. This page sets up a Java repository and shows what the agents and you can ask of it. It assumes [Start with one repository](./first-run.md); everything there holds here too.

Reading Java needs no JDK: MetatorAI parses the source itself. The gates do need one, since they build the code with the repository's own build.

<WaySwitch />

## Set up a Java repository

<Way app>

**Add repository**, then choose the repository's folder. The app looks at it and says what it found in one line under the title, for example **Java · Maven, 5 modules**, or **Java · Gradle, Kotlin DSL, 2 modules**. A repository with a `package.json` beside the build reads **Java, TypeScript · Maven, 5 modules**. The list of files setup will write is the same as in any repository. Choose the AI host, then **Set up**.

</Way>

<Way cli>

In the root of the repository, where `pom.xml`, `settings.gradle(.kts)` or `build.gradle(.kts)` is:

```bash
cd ~/code/shop
metator inspect .
```

```text
/home/you/code/shop: repo
  shop (/home/you/code/shop): set up no; Java · Maven, 5 modules
```

```bash
metator setup --host claude --yes
```

</Way>

Setup finds the build at the root: Maven when a `pom.xml` is there, Gradle when a settings or build script is. It reads the build the way `metator java modules` does, without running it. A repository with no `package.json` needs no npm, and none of what setup or doctor says is about `node_modules`. A repository with both gets the gates of both. An existing `metator.config.yml` is never overwritten.

## The gates setup writes

| Gate step | Maven | Gradle |
|---|---|---|
| `typecheck`: compile | `-q -B -DskipTests compile` | `compileJava compileTestJava -q` |
| `test` | `-B test` | `test` |
| `lint`, only when the build configures Checkstyle, PMD or SpotBugs | `checkstyle:check`, `pmd:check`, `spotbugs:check` (SpotBugs after `compile`) | `checkstyleMain checkstyleTest`, `pmdMain pmdTest`, `spotbugsMain spotbugsTest` |
| `format`, only when the build configures Spotless | `spotless:check` | `spotlessCheck` |

The build runs through its wrapper when the repository has one, else through `mvn` or `gradle` from your PATH. Which wrapper is decided where the gate runs: `mvnw` and `gradlew` on Linux and macOS, `mvnw.cmd` and `gradlew.bat` on Windows. The config names only the tool (`build: maven`), so one `metator.config.yml` works for colleagues on Windows and on Linux. A plugin counts when the build runs it by default: one only under `<pluginManagement>`, `<reporting>` or a profile does not. Every step only checks: none applies a format or fixes a file.

On the Maven fixture of MetatorAI's own tests (a parent POM with five modules), setup writes:

```yaml
kind: MetatorConfig
schemaVersion: 16
gates:
  quick:
    - id: typecheck
      run:
        build: maven
        args: [-q, -B, -DskipTests, compile]
      files: modules
      match: ["**/*.java", "**/*.kt", "**/pom.xml", "**/*.gradle", "**/*.gradle.kts", "**/src/*/resources/**"]
    - id: test
      run:
        build: maven
        args: [-B, test]
      files: modules
      match: ["**/*.java", "**/*.kt", "**/pom.xml", "**/*.gradle", "**/*.gradle.kts", "**/src/*/resources/**"]
  full:
    - id: typecheck
      run:
        build: maven
        args: [-q, -B, -DskipTests, compile]
    - id: test
      run:
        build: maven
        args: [-B, test]
```

(Setup writes the lists one item per line; they are shortened here.) `run: { build: maven | gradle, args }` and `files: modules` are new in MetatorConfig v16; [Configuration](../reference/configuration.md) has every field.

### The quick gate builds only the modules of the change

`files: modules` narrows a quick gate to the modules the changed files are in. A file's module is the deepest module of the default build that holds it, as `metator java modules` lists them; Maven builds those modules and what they need (`-pl <modules> -am`), Gradle runs each task in each module's project (`:inventory-core:test`). A change outside them (the parent POM, the settings script, Gradle's `buildSrc`, a module only a profile builds) builds everything, and a change no build reads (a README) skips the steps. The full gate always builds everything.

```bash
metator gate quick --files shop-api/src/main/java/com/example/shop/api/OrderController.java
```

```json
{"ok":true,"data":{"gate":"quick","files":["shop-api/src/main/java/com/example/shop/api/OrderController.java"],"passed":true,
 "steps":[{"id":"typecheck","command":["mvn","-pl","shop-api","-am","-q","-B","-DskipTests","compile"],"exitCode":0,"status":"pass"},
          {"id":"test","command":["mvn","-pl","shop-api","-am","-B","test"],"exitCode":0,"status":"pass"}]}}
```

An agent may run these commands, through the wrapper (`./mvnw`, or `mvnw.cmd` on Windows) or from PATH, without asking you: they are the repository's own checks. Another goal (`mvn deploy`) still asks.

## Check the machine: doctor

```bash
metator doctor
```

```text
  ✓ dependencies        not a Node project: nothing to install
  ✓ jdk                 JDK 21; the build declares Java 21 (shop-common/pom.xml:15 <maven.compiler.release>)
  ✓ build               Maven runs as mvn from PATH (no mvnw)
  ✓ build-dependencies  Maven's local cache is here (~/.m2/repository); whether every dependency resolves shows when the build runs
```

- `jdk`: a JDK answers `java -version`, and it is at least the highest Java version the build declares: `maven.compiler.release`, `<release>`, `<source>` or Spring Boot's `java.version` in any POM; a toolchain's `languageVersion`, `jvmToolchain`, `options.release` or `sourceCompatibility` in a Gradle script. The evidence names the file and line.
- `build`: the wrapper of this machine's platform (`mvnw.cmd`, `gradlew.bat` on Windows), or the tool on PATH.
- `build-dependencies`: doctor does not use the network, so whether every dependency resolves is known only when the build runs. It warns when the tool has never downloaded anything on this machine (no `~/.m2/repository`, no Gradle cache): the first build needs the network. `metator doctor --gates` runs the quick gate once and says whether it is green.

Each of them is at most a warning: a run starts, and its gates will say what is wrong.

## Read a Java repository

Ask in a chat, as about any code: "Which endpoints does the order API have?", "What injects `OrderService`?", "Which configuration keys change in the `prod` profile?". The agents that read code (`mt-guide`, `mt-chat`, `mt-scout`, the planners, the reviewers and others) have the `metator java` commands and the skill `mt-read-java`, which says which command answers which question. They answer with the facts those commands measure, each with its `path:line`, and say when a fact is only likely.

From the terminal, the same commands:

| Command | What it lists |
|---|---|
| `metator java overview` | Build tools, modules, Java versions, source roots, counts, frameworks with evidence, files it could not parse |
| `metator java modules` | Each module: directory, packaging, parent, the modules it depends on, external dependencies with scope |
| `metator java types [--kind …] [--annotated <Name>] [--implements <Type>]` | Types, one line each |
| `metator java show <Type>` | One type in full: members, annotations, supertypes, subtypes, where it is used |
| `metator java endpoints [--framework spring-mvc\|webflux\|jax-rs\|servlet]` | HTTP endpoints: method, path, handler, parameters, request and response types |
| `metator java entities` / `metator java repositories` | JPA entities with columns and relations; Spring Data repositories with their queries |
| `metator java beans [--injects <Type>]` | Spring, CDI, EJB and XML beans with their injection points and the bean that provides each |
| `metator java config [--key <prefix>]` | Configuration keys by profile, and where code reads them |
| `metator java entrypoints` | `main`, `@Scheduled`, message listeners, `@EventListener` |
| `metator java index [--check]` | Builds or checks the cache under `.metator/` |

Every list takes `--module <name>` and `--package <prefix>`. `graph dependents`, `graph affected`, `symbols find`, `cards` and `similar` work on `.java` files too, and the modules count as the repository's packages.

On the Maven fixture of MetatorAI's own tests, at a terminal:

```bash
metator java overview
```

```text
Java · maven, 7 modules
Java 17, 21
47 files, 50 types, 17 endpoints, 9 entities, 2 repositories, 23 beans, 13 config keys, 5 entry points
Frameworks: spring-boot (2), spring-mvc (13), spring-webflux (3), spring-data (2), jpa (10), jax-rs (3), ejb (4), cdi (4), servlet (2), spring (11), spring-xml (2)

Could not fully parse 1 file(s); the rest was read:
  shop-experimental/src/main/java/com/example/shop/experimental/Broken.java:5  syntax error: missing ";"
```

The overview lists the parent POM and a profile's modules too (here 7); the line of **Add repository** counts the modules the default build lists (5). A file it cannot parse is named, and everything else is still read.

```bash
metator java endpoints --module shop-api
```

```text
GET     /api/customers/{id}  CustomerController#get → CustomerDto                            spring-mvc (likely)  shop-api/src/main/java/com/example/shop/api/CustomerController.java:20
GET     /api/orders          OrderController#list → List<com.example.shop.api.dto.OrderDto>  spring-mvc           shop-api/src/main/java/com/example/shop/api/OrderController.java:37
POST    /api/orders          OrderController#create → OrderDto                               spring-mvc           shop-api/src/main/java/com/example/shop/api/OrderController.java:42
DELETE  /api/orders/{id}     OrderController#cancel                                          spring-mvc           shop-api/src/main/java/com/example/shop/api/OrderController.java:48
GET     /api/orders/{id}     OrderController#get → OrderDto                                  spring-mvc           shop-api/src/main/java/com/example/shop/api/OrderController.java:32
```

```bash
metator java beans --injects OrderService
```

```text
orderController  OrderController  @RestController  shop-api/src/main/java/com/example/shop/api/OrderController.java:22
  ← constructor orderService: OrderService = orderService
  ← constructor pricing: PricingService = pricingService
```

```bash
metator java config --key shop
```

```text
shop.currency = USD  [local]  shop-api/src/main/resources/application-local.properties:2
shop.currency = EUR  shop-api/src/main/resources/application.yml:4
shop.tax-rate = 0.23  shop-api/src/main/resources/application.yml:5
shop.orders.max-lines = 50  shop-api/src/main/resources/application.yml:7
shop.currency = PLN  [dev]  shop-api/src/main/resources/application.yml:17
shop.orders.allow-guests = false  [prod]  shop-api/src/main/resources/application.yml:28

Read by:
  shop.currency  @Value PricingService.currency (default EUR)  shop-api/src/main/java/com/example/shop/api/PricingService.java:10
  shop.tax-rate  @Value PricingService.taxRate  shop-api/src/main/java/com/example/shop/api/PricingService.java:13
  shop.orders.max-lines  @ConfigurationProperties ShopProperties.maxLines  shop-api/src/main/java/com/example/shop/api/ShopProperties.java:7
  shop.orders.allow-guests  @ConfigurationProperties ShopProperties.allowGuests  shop-api/src/main/java/com/example/shop/api/ShopProperties.java:8
```

Piped, or with `--json`, each command prints its facts as JSON, with `at` (`path:line`) and `evidence` on every fact; that is what the agents read.

### Likely and certain

A fact found by a rule that cannot be sure says so with `confidence: "likely"`: a path built from a constant, a route of a `RouterFunction`, an injection that several beans could satisfy. An agent reports such a fact as likely, with the evidence that made it.

## Java beside TypeScript

A Java repository can stay as it is and be read from a TypeScript repository next to it: put both in a folder ([Start with many repositories](./many.md)), and an agent in the TypeScript repository reads the Java one with `metator -C ../legacy-shop java endpoints`. Set up the Java repository itself when agents should also change it and run its gates.

Reading is all this does for now: planning a port of Java code to TypeScript is not part of it.
