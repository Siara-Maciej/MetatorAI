import { describe, expect, test } from "bun:test";
import {
  analyzeModules,
  type ModuleImport,
  moduleDirOf,
  moduleViolations,
  proposeModuleGlobs,
} from "../src/domain/architecture-modules.ts";

const imp = (from: string, to: string, typeOnly = false): ModuleImport => ({ from, to, typeOnly });
const isTest = (f: string) => f.endsWith(".spec.ts");
const M = "src/module";

const FILES = [
  `${M}/users/users.service.ts`,
  `${M}/users/contracts/get-user.query.ts`,
  `${M}/users/users.service.spec.ts`,
  `${M}/auth/auth.service.ts`,
  `${M}/orders/orders.service.ts`,
  `${M}/orders/order.entity.ts`,
  `${M}/mail/mail.service.ts`,
  "src/main.ts",
];

describe("modules inside a package", () => {
  test("a file's module is the directory a glob matches; the directory itself and other files have none", () => {
    expect(moduleDirOf(`${M}/users/x/y.ts`, [`${M}/*`])).toBe(`${M}/users`);
    expect(moduleDirOf(`${M}/users`, [`${M}/*`])).toBeUndefined();
    expect(moduleDirOf("src/main.ts", [`${M}/*`])).toBeUndefined();
    expect(moduleDirOf("apps/web/features/Cart/a.tsx", ["apps/*/features/*"])).toBe("apps/web/features/Cart");
  });

  test("edges, pairs that import each other, cycles; tests and files outside modules are left out", () => {
    const r = analyzeModules({
      policy: { globs: [`${M}/*`] },
      files: FILES,
      imports: [
        imp(`${M}/auth/auth.service.ts`, `${M}/users/users.service.ts`),
        imp(`${M}/users/users.service.ts`, `${M}/auth/auth.service.ts`),
        imp(`${M}/users/users.service.ts`, `${M}/orders/orders.service.ts`, true),
        imp(`${M}/orders/orders.service.ts`, `${M}/auth/auth.service.ts`, true),
        imp(`${M}/users/users.service.spec.ts`, `${M}/mail/mail.service.ts`),
        imp("src/main.ts", `${M}/mail/mail.service.ts`),
        imp(`${M}/orders/orders.service.ts`, `${M}/orders/order.entity.ts`),
      ],
      isTest,
    });
    expect(r.modules.map((m) => [m.name, m.files, m.dependsOn, m.dependents])).toEqual([
      ["auth", 1, ["users"], ["orders", "users"]],
      ["mail", 1, [], []],
      ["orders", 2, ["auth"], ["users"]],
      ["users", 2, ["auth", "orders"], ["auth"]],
    ]);
    expect(r.twoWay).toEqual([["auth", "users"]]);
    // auth ⇄ users at runtime; orders joins only through import type, still one cycle (not type-only).
    expect(r.cycles.map((c) => [c.modules, c.typeOnly])).toEqual([[["auth", "orders", "users"], false]]);
    expect(r.edges.find((e) => e.from === "users" && e.to === "orders")).toMatchObject({
      imports: 1,
      runtime: 0,
    });
  });

  test("a cycle closed only by import type is type-only", () => {
    const r = analyzeModules({
      policy: { globs: [`${M}/*`] },
      files: FILES,
      imports: [
        imp(`${M}/auth/auth.service.ts`, `${M}/users/users.service.ts`, true),
        imp(`${M}/users/users.service.ts`, `${M}/auth/auth.service.ts`),
      ],
      isTest,
    });
    expect(r.cycles.map((c) => c.typeOnly)).toEqual([true]);
    expect(moduleViolations(r).map((v) => [v.kind, v.typeOnly])).toEqual([["module-cycle", true]]);
  });

  test("with a public part, imports past it are internal; the module's own files never are", () => {
    const r = analyzeModules({
      policy: { globs: [`${M}/*`], public: ["contracts/**"] },
      files: FILES,
      imports: [
        imp(`${M}/auth/auth.service.ts`, `${M}/users/contracts/get-user.query.ts`),
        imp(`${M}/auth/auth.service.ts`, `${M}/users/users.service.ts`),
        imp(`${M}/orders/orders.service.ts`, `${M}/orders/order.entity.ts`),
      ],
      isTest,
    });
    expect(r.edges.map((e) => [e.from, e.to, e.imports, e.internal])).toEqual([["auth", "users", 2, 1]]);
    // One way only: no pair imports each other.
    expect(r.twoWay).toEqual([]);
    expect(moduleViolations(r)).toEqual([
      {
        kind: "module-internal",
        subject: "auth→users",
        message: "auth imports users past its public part (contracts/**) 1 time(s)",
        modules: ["auth", "users"],
        evidence: [{ file: `${M}/auth/auth.service.ts`, to: `${M}/users/users.service.ts` }],
      },
    ]);
    // Without a public part every file is public.
    const open = analyzeModules({
      policy: { globs: [`${M}/*`] },
      files: FILES,
      imports: [imp(`${M}/auth/auth.service.ts`, `${M}/users/users.service.ts`)],
      isTest,
    });
    expect(moduleViolations(open)).toEqual([]);
  });

  test("folders of one name in different packages are named by package, then by path", () => {
    const files = [
      "apps/web/features/Auth/a.ts",
      "apps/admin/features/Auth/a.ts",
      "apps/web/features/Cart/a.ts",
    ];
    const names = (packageOf?: (d: string) => string) =>
      analyzeModules({
        policy: { globs: ["apps/*/features/*"] },
        files,
        imports: [],
        isTest,
        ...(packageOf ? { packageOf } : {}),
      }).modules.map((m) => m.name);
    expect(names((d) => d.split("/")[1] as string)).toEqual(["admin/Auth", "web/Auth", "Cart"]);
    expect(names(() => "same")).toEqual(["apps/admin/features/Auth", "apps/web/features/Auth", "Cart"]);
  });

  test("proposed globs: a module folder with three or more modules", () => {
    expect(
      proposeModuleGlobs([
        "src/module/a/x.ts",
        "src/module/b/x.ts",
        "src/module/c/x.ts",
        "apps/web/features/One/x.tsx",
        "apps/web/features/Two/x.tsx",
        "src/lib/a/x.ts",
      ]),
    ).toEqual(["src/module/*"]);
  });
});
