import { describe, expect, test } from "bun:test";
import { isJavaDescriptor, profileOfConfigFile } from "@metator/core";
import { JavaDescriptors, properties, yamlConfig } from "../src/java-descriptor-parser.ts";

const d = new JavaDescriptors();

describe("JavaDescriptors", () => {
  test("web.xml: each servlet with its url patterns", () => {
    const facts = d
      .parse(
        "WEB-INF/web.xml",
        `<?xml version="1.0"?>
<web-app xmlns="https://jakarta.ee/xml/ns/jakartaee">
  <servlet>
    <servlet-name>reports</servlet-name>
    <servlet-class>com.x.ReportServlet</servlet-class>
  </servlet>
  <servlet-mapping><servlet-name>reports</servlet-name><url-pattern>/r/*</url-pattern><url-pattern>/reports</url-pattern></servlet-mapping>
  <servlet><servlet-name>unmapped</servlet-name><servlet-class>com.x.U</servlet-class></servlet>
</web-app>`,
      )
      ._unsafeUnwrap();
    expect(facts.servlets).toEqual([
      { name: "reports", className: "com.x.ReportServlet", urlPatterns: ["/r/*", "/reports"], line: 3 },
      { name: "unmapped", className: "com.x.U", urlPatterns: [], line: 8 },
    ]);
  });

  test("persistence.xml: units with their transaction type, provider and classes", () => {
    const facts = d
      .parse(
        "META-INF/persistence.xml",
        `<persistence><persistence-unit name="pu" transaction-type="JTA"><provider>org.h.P</provider><class>a.B</class><class>a.C</class></persistence-unit></persistence>`,
      )
      ._unsafeUnwrap();
    expect(facts.persistenceUnits).toEqual([
      { name: "pu", transactionType: "JTA", provider: "org.h.P", classes: ["a.B", "a.C"], line: 1 },
    ]);
  });

  test("Spring XML: beans (nested <beans> too) with property and constructor references", () => {
    const facts = d
      .parse(
        "src/main/resources/ctx.xml",
        `<beans xmlns="http://www.springframework.org/schema/beans">
  <bean id="a" class="x.A" scope="prototype"/>
  <bean id="b" class="x.B">
    <property name="a" ref="a"/>
    <property name="mode" value="fast"/>
    <property name="other"><ref bean="c"/></property>
    <constructor-arg ref="a"/>
  </bean>
  <beans profile="dev"><bean name="c,alias" class="x.C"/></beans>
</beans>`,
      )
      ._unsafeUnwrap();
    expect(facts.beans.map((b) => [b.id, b.className, b.scope])).toEqual([
      ["a", "x.A", "prototype"],
      ["b", "x.B", undefined],
      ["c", "x.C", undefined],
    ]);
    expect(facts.beans[1]?.properties).toEqual([
      { name: "a", ref: "a", line: 4 },
      { name: "mode", value: "fast", line: 5 },
      { name: "other", ref: "c", line: 6 },
    ]);
    expect(facts.beans[1]?.constructorArgs).toEqual([{ ref: "a", line: 7 }]);
  });

  test("other XML is no facts; XML that is not well-formed is an error value", () => {
    expect(d.parse("src/main/resources/logback.xml", "<configuration/>")._unsafeUnwrap().beans).toEqual([]);
    const bad = d.parse("WEB-INF/web.xml", "<web-app><servlet></web-app>");
    expect(bad.isErr()).toBe(true);
    expect(bad._unsafeUnwrapErr().code).toBe("PARSE_FAILED");
  });

  test("application.yml: dotted keys, lists, one profile per document", () => {
    const keys = yamlConfig(
      `server:
  port: 8080
shop:
  tags: [a, b]
---
spring:
  config:
    activate:
      on-profile: dev
server.port: 9090
---
spring.profiles: legacy
x: 1
`,
      undefined,
    )._unsafeUnwrap();
    expect(keys).toEqual([
      { key: "server.port", value: "8080", line: 2 },
      { key: "shop.tags[0]", value: "a", line: 4 },
      { key: "shop.tags[1]", value: "b", line: 4 },
      { key: "spring.config.activate.on-profile", value: "dev", profile: "dev", line: 9 },
      { key: "server.port", value: "9090", profile: "dev", line: 10 },
      { key: "spring.profiles", value: "legacy", profile: "legacy", line: 12 },
      { key: "x", value: "1", profile: "legacy", line: 13 },
    ]);
  });

  test("application-<profile>.properties: the file's profile; comments, continuations, separators", () => {
    const keys = properties(
      "# c\n! c\na=1\nb: two\nc   three\nlong=x\\\n   y\n#---\nspring.config.activate.on-profile=other\nd=4\n",
      "dev",
    );
    expect(keys).toEqual([
      { key: "a", value: "1", profile: "dev", line: 3 },
      { key: "b", value: "two", profile: "dev", line: 4 },
      { key: "c", value: "three", profile: "dev", line: 5 },
      { key: "long", value: "xy", profile: "dev", line: 6 },
      { key: "spring.config.activate.on-profile", value: "other", profile: "other", line: 9 },
      { key: "d", value: "4", profile: "other", line: 10 },
    ]);
    expect(d.parse("x/application-dev.properties", "a=1")._unsafeUnwrap().config[0]?.profile).toBe("dev");
  });

  test("which files are descriptors, and a config file's profile", () => {
    expect(isJavaDescriptor("app/src/main/resources/application.yml")).toBe(true);
    expect(isJavaDescriptor("app/src/main/resources/application-prod.properties")).toBe(true);
    expect(isJavaDescriptor("app/src/main/webapp/WEB-INF/web.xml")).toBe(true);
    expect(isJavaDescriptor("app/src/main/resources/applicationContext.xml")).toBe(true);
    expect(isJavaDescriptor("app/pom.xml")).toBe(false);
    expect(isJavaDescriptor("docs/diagram.xml")).toBe(false);
    expect(isJavaDescriptor("config.yml")).toBe(false);
    expect(d.parse("a/application.yml", "a: [unclosed")._unsafeUnwrapErr().code).toBe("PARSE_FAILED");
    expect(profileOfConfigFile("a/application-prod.yml")).toBe("prod");
    expect(profileOfConfigFile("a/application.yml")).toBeUndefined();
  });
});
