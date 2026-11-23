import { afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonorepo, importAnalyzerContract } from "@metator/testing";
import { OxcImportAnalyzer } from "../src/oxc-import-analyzer.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

importAnalyzerContract("OxcImportAnalyzer", async () => {
  const root = await mkdtemp(join(tmpdir(), "metator-oxc-contract-"));
  roots.push(root);
  await createMonorepo(root);
  return {
    analyzer: new OxcImportAnalyzer(root),
    local: {
      from: "packages/billing/src/tax.ts",
      content: 'import { round } from "./round.ts";\nexport const tax = (n: number) => round(n * 0.23);\n',
      specifier: "./round.ts",
      file: "packages/billing/src/round.ts",
    },
    external: {
      from: "apps/web/src/main.ts",
      content: 'import { chunk } from "lodash";\nexport const x = chunk;\n',
      specifier: "lodash",
    },
    garbage: "export const = = ;",
  };
});
