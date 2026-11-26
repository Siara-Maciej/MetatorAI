import { cp } from "node:fs/promises";
import { join } from "node:path";
import { ScratchRepo } from "./repo.ts";

/**
 * The Java fixtures (`e2e/fixtures/java/`), each copied into a fresh git repository:
 * - `maven`: "shop", a multi-module Maven build (Spring MVC, JPA, Spring Data, WebFlux, JAX-RS,
 *   EJB, CDI, Servlets, Spring XML, a Java 21 module, a generated source). `shop-experimental`
 *   is only listed in the `experimental` profile, which is not active by default: its
 *   `Broken.java` has a syntax error and the default build never compiles it.
 * - `gradle`: "inventory", a two-project Gradle build in the Kotlin DSL.
 */
const JAVA_FIXTURES = join(import.meta.dir, "../fixtures/java");

export type JavaFixture = "maven" | "gradle";

/** A temp git repository holding the fixture, committed once. */
export async function createJavaRepo(fixture: JavaFixture): Promise<ScratchRepo> {
  const repo = await ScratchRepo.create();
  await cp(join(JAVA_FIXTURES, fixture), repo.root, { recursive: true });
  await repo.commit("init");
  return repo;
}

/** The fixture's files copied into an existing directory (a folder of repositories). */
export async function copyJavaFixture(fixture: JavaFixture, dir: string): Promise<void> {
  await cp(join(JAVA_FIXTURES, fixture), dir, { recursive: true });
}

/**
 * Why a test that needs a real build tool cannot run here, or undefined when it can. Tests that
 * build the fixture skip with this reason; they never pass silently without the tool.
 */
export function missingBuildTool(tool: "mvn" | "gradle"): string | undefined {
  return Bun.which(tool) ? undefined : `${tool} is not installed: the real ${tool} build is not tested here`;
}
