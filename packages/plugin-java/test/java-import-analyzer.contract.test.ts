import { afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importAnalyzerContract } from "@metator/testing";
import { JavaImportAnalyzer } from "../src/java-import-analyzer.ts";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const service = `package com.shop.service;

import com.shop.domain.Order;
import java.util.List;

public class OrderService {
  List<Order> all() { return List.of(); }
}
`;

importAnalyzerContract("JavaImportAnalyzer", async () => {
  const root = await mkdtemp(join(tmpdir(), "metator-java-contract-"));
  roots.push(root);
  await Bun.write(
    join(root, "domain/src/main/java/com/shop/domain/Order.java"),
    "package com.shop.domain;\npublic class Order {}\n",
  );
  await Bun.write(join(root, "app/src/main/java/com/shop/service/OrderService.java"), service);
  return {
    analyzer: new JavaImportAnalyzer(root),
    local: {
      from: "app/src/main/java/com/shop/service/OrderService.java",
      content: service,
      specifier: "com.shop.domain.Order",
      file: "domain/src/main/java/com/shop/domain/Order.java",
    },
    external: {
      from: "app/src/main/java/com/shop/service/OrderService.java",
      content: service,
      specifier: "java.util.List",
    },
    garbage: "public class { int x( ",
  };
});
