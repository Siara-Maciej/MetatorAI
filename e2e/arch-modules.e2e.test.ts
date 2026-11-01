/**
 * Modules inside a package (ADR-0074) end to end: a NestJS-shaped modular monolith (one package,
 * `src/module/*` with tsconfig path aliases, `contracts/` as each module's public part). `arch
 * init` proposes the modules, `arch analyze` finds the pairs that import each other and the
 * cycle, and `arch check` fails a change only for the boundary it breaks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { metator } from "./helpers/cli.ts";
import { ScratchRepo } from "./helpers/repo.ts";

let repo: ScratchRepo;
const mt = (...args: string[]) => metator(args, repo.root);
type Data = Record<string, unknown>;

beforeAll(async () => {
  repo = await ScratchRepo.create();
  const files: Record<string, string> = {
    ".gitignore": ".metator/\n",
    "package.json": `${JSON.stringify({ name: "api", private: true, scripts: { start: "nest start" } }, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { baseUrl: "./src", paths: { "module/*": ["module/*"] } } }, null, 2)}\n`,
    "src/main.ts":
      'import { UsersModule } from "module/users/users.module";\nexport const app = UsersModule;\n',
    "src/module/users/users.module.ts":
      'import { AuthService } from "module/auth/auth.service";\nexport const UsersModule = AuthService;\n',
    "src/module/users/users.service.ts": "export const UsersService = 1;\n",
    "src/module/users/contracts/get-user.query.ts": "export class GetUserQuery {}\n",
    // auth reaches into users' service instead of its contracts: an internal import, and a cycle.
    "src/module/auth/auth.service.ts":
      'import { UsersService } from "module/users/users.service";\nexport const AuthService = UsersService;\n',
    "src/module/orders/orders.service.ts":
      'import { GetUserQuery } from "module/users/contracts/get-user.query";\nexport const q = GetUserQuery;\n',
    "src/module/mail/mail.service.ts": "export const mail = 1;\n",
  };
  for (const [path, text] of Object.entries(files)) await repo.write(path, text);
  await repo.commit("init");
}, 60_000);

afterAll(async () => {
  await repo.dispose();
});

describe("modules inside a package (real CLI)", () => {
  test("arch init proposes the module folder and contracts/ as the public part", async () => {
    const r = await mt("arch", "init");
    expect(r.code).toBe(0);
    expect((r.json.data as Data).policy).toMatchObject({
      modules: { globs: ["src/module/*"], public: ["contracts/**"] },
    });
    expect(await repo.read("metator/architecture.yml")).toContain("schemaVersion: 2");
  });

  test("arch analyze: the pair that imports each other, the cycle, and the import past contracts/", async () => {
    const r = await mt("arch", "analyze");
    expect(r.code).toBe(0);
    const report = JSON.parse(await repo.read(".metator/arch/report.json")) as {
      schemaVersion: number;
      modules: { modules: { name: string }[]; twoWay: string[][]; cycles: { modules: string[] }[] };
      violations: { id: string }[];
    };
    expect(report.schemaVersion).toBe(2);
    expect(report.modules.modules.map((m) => m.name)).toEqual(["auth", "mail", "orders", "users"]);
    expect(report.modules.twoWay).toEqual([["auth", "users"]]);
    expect(report.modules.cycles.map((c) => c.modules)).toEqual([["auth", "users"]]);
    // orders uses users' contracts only: no violation for it.
    expect(report.violations.map((v) => v.id).filter((id) => id.startsWith("module"))).toEqual([
      "module-cycle:auth,users",
      "module-internal:auth→users",
      "module-internal:users→auth",
    ]);
    expect(await repo.read(".metator/arch/report.md")).toContain("Import each other (1): auth ⇄ users.");
  });

  test("with the current state accepted, arch check fails only for a new import past another module's contracts", async () => {
    expect((await mt("arch", "baseline")).code).toBe(0);
    expect((await mt("arch", "check")).code).toBe(0);
    await repo.write(
      "src/module/mail/mail.service.ts",
      'import { UsersService } from "module/users/users.service";\nexport const mail = UsersService;\n',
    );
    const r = await mt("arch", "check");
    expect(r.code).toBe(1);
    const added = (
      (r.json.error as { details: Data }).details.added as { id: string; evidence: { file: string }[] }[]
    ).map((v) => [v.id, v.evidence[0]?.file]);
    expect(added).toEqual([["module-internal:mail→users", "src/module/mail/mail.service.ts"]]);
  });
});
