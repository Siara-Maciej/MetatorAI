/** MT-CODE-005: every third-party dependency is in the register with the ADR that approved it. */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { files, ROOT, read } from "./lib.ts";

const Register = z.strictObject({
  kind: z.literal("DependencyRegister"),
  schemaVersion: z.literal(1),
  description: z.string(),
  packages: z.array(z.strictObject({ package: z.string(), need: z.string(), adr: z.string() })),
});
type Register = z.output<typeof Register>;

const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/** Third-party packages a manifest depends on (workspace packages are ours). */
function dependenciesOf(manifest: Record<string, unknown>): string[] {
  return FIELDS.flatMap((f) => Object.keys((manifest[f] as Record<string, string> | undefined) ?? {})).filter(
    (name) => !name.startsWith("@metator/"),
  );
}

function problems(
  register: Register,
  manifests: ReadonlyMap<string, Record<string, unknown>>,
  adrExists: (file: string) => boolean,
): string[] {
  const registered = new Map(register.packages.map((p) => [p.package, p]));
  const used = new Set<string>();
  const out: string[] = [];
  for (const [file, manifest] of manifests) {
    for (const name of dependenciesOf(manifest)) {
      used.add(name);
      // Type packages follow the package (or runtime) they describe.
      const subject = name.startsWith("@types/") ? name.slice("@types/".length) : name;
      if (
        !registered.has(name) &&
        !(name.startsWith("@types/") && (registered.has(subject) || subject === "bun"))
      )
        out.push(`${file}: ${name} is not in docs/metator/dependencies.yml (approve it with an ADR first)`);
    }
  }
  for (const p of register.packages) {
    if (!used.has(p.package))
      out.push(`docs/metator/dependencies.yml: ${p.package} is registered but unused`);
    if (!adrExists(p.adr))
      out.push(`docs/metator/dependencies.yml: ${p.package} cites missing docs/adr/${p.adr}`);
  }
  return out;
}

describe("MT-CODE-005", () => {
  test("every dependency is registered with an existing ADR", async () => {
    const register = Register.parse(parse(await read("docs/metator/dependencies.yml")));
    const manifests = new Map<string, Record<string, unknown>>();
    for (const f of ["package.json", ...(await files("packages/*/package.json"))])
      manifests.set(f, JSON.parse(await read(f)) as Record<string, unknown>);
    expect(problems(register, manifests, (adr) => existsSync(join(ROOT, "docs/adr", adr)))).toEqual([]);
  });

  test("rejects an unregistered package, a stale entry and a missing ADR", () => {
    const register: Register = {
      kind: "DependencyRegister",
      schemaVersion: 1,
      description: "",
      packages: [
        { package: "zod", need: "schemas", adr: "0015.md" },
        { package: "left-pad", need: "padding", adr: "0099.md" },
      ],
    };
    const manifests = new Map([
      [
        "packages/core/package.json",
        {
          dependencies: { zod: "^4", lodash: "^4", "@metator/x": "workspace:*" },
          devDependencies: { "@types/zod": "1", "@types/bun": "1" },
        },
      ],
    ]);
    expect(problems(register, manifests, (adr) => adr === "0015.md")).toEqual([
      "packages/core/package.json: lodash is not in docs/metator/dependencies.yml (approve it with an ADR first)",
      "docs/metator/dependencies.yml: left-pad is registered but unused",
      "docs/metator/dependencies.yml: left-pad cites missing docs/adr/0099.md",
    ]);
  });
});
