import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ContainerEngine,
  chooseEngine,
  DevContainers,
  err,
  type FoundEngine,
  LINUX_BUNDLE_KIND,
  type LinuxBundle,
  linuxBundleOf,
  MetatorError,
  type Result,
} from "@metator/core";
import { DockerCliEngine, engineFacts, NerdctlCliEngine } from "@metator/plugin-docker";

/** The manifest beside each architecture's tarball (packages/cli/src/linux-bundle.ts). */
const MANIFEST = "metator-bundle.json";

/**
 * `metator devcontainer …` (ADR-0106) as the composition root builds it, on the person's computer:
 * the container CLI found on PATH (docker first, then nerdctl, each only when its engine answers)
 * and the Linux CLI bundles in `bundles` (`<bundles>/<arch>/metator-bundle.json`: the desktop app's
 * `linux-cli` resources). No repository is needed.
 */
export async function devContainers(o: {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The folder of the Linux CLI bundles; none: this installation carries none. */
  readonly bundles: string | undefined;
}): Promise<DevContainers> {
  const path = o.env.PATH ?? o.env.Path ?? "";
  const which = (name: string) => Bun.which(name, { PATH: path });
  const docker = o.env.METATOR_DOCKER_BIN;
  const facts = await Promise.all([
    engineFacts("docker", (name) => (docker ? (Bun.which(docker, { PATH: path }) ?? docker) : which(name))),
    engineFacts("nerdctl", which),
  ]);
  const chosen = chooseEngine(facts);
  const engine: FoundEngine =
    "problem" in chosen
      ? chosen
      : {
          info: chosen.engine,
          cli: (chosen.engine.program === "docker"
            ? new DockerCliEngine(chosen.engine.path)
            : new NerdctlCliEngine(chosen.engine.path)) satisfies ContainerEngine,
        };
  return new DevContainers({ engine, bundle: (arch) => bundleIn(o.bundles, arch) });
}

/** The bundle of an architecture in the bundles folder, read from its manifest. */
export function bundleIn(dir: string | undefined, arch: "x64" | "arm64"): Result<LinuxBundle, MetatorError> {
  const missing = (what: string) =>
    err(
      new MetatorError("NOT_FOUND", what, {
        hint: "The Windows and macOS apps carry the Linux CLI; from a terminal, pass --bundles <folder> (or METATOR_LINUX_BUNDLES): a folder with x64/ and arm64/ as `bun scripts/linux-cli-bundle.ts` makes them.",
      }),
    );
  if (dir === undefined) return missing("this installation of MetatorAI carries no Linux CLI bundle");
  const file = join(dir, arch, MANIFEST);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return existsSync(file)
      ? err(
          new MetatorError(
            "INVALID_ARTIFACT",
            `${file} is not a ${LINUX_BUNDLE_KIND} manifest: ${(e as Error).message}`,
          ),
        )
      : missing(`no Linux CLI bundle for ${arch}: ${file} is not there`);
  }
  const bundle = linuxBundleOf(raw, arch, (name) => join(dir, arch, name));
  if (bundle.isOk() && !existsSync(bundle.value.tarball))
    return missing(`the Linux CLI's tarball is not there: ${bundle.value.tarball}`);
  return bundle;
}
