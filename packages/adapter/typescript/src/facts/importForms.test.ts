import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "./store.js";

import type { CallExpression } from "ts-morph";

const PACKAGE = "@probe/provider";

function calleeNamesIn(consumer: string): string[] {
  const project = createTestProject();
  project.createSourceFile(
    `/node_modules/${PACKAGE}/package.json`,
    JSON.stringify({ name: PACKAGE, types: "index.d.ts" }),
  );
  project.createSourceFile(
    `/node_modules/${PACKAGE}/index.d.ts`,
    "export declare function alpha(count: number): { count: number };\nexport declare function createClient(): { getUser(id: string): unknown };\n",
  );
  const file = project.createSourceFile("/consumer.ts", consumer);
  const store = new ResolutionStore();

  const calls: CallExpression[] = [];
  file.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      calls.push(node);
    }
  });
  const last = calls[calls.length - 1];
  if (last === undefined) {
    throw new Error("no call in fixture");
  }
  return store
    .importOriginsOf(last.getExpression(), [PACKAGE])
    .map((one) => one.path.join("."));
}

describe("what importedNamesOf resolves per import form", () => {
  it("named import", () => {
    expect(
      calleeNamesIn(
        `import { alpha } from "${PACKAGE}";\nexport const run = (n: number) => alpha(n);\n`,
      ),
    ).toEqual(["alpha"]);
  });

  it("aliased import", () => {
    expect(
      calleeNamesIn(
        `import { alpha as fromProvider } from "${PACKAGE}";\nexport const run = (n: number) => fromProvider(n);\n`,
      ),
    ).toEqual(["alpha"]);
  });

  it("namespace member", () => {
    expect(
      calleeNamesIn(
        `import * as provider from "${PACKAGE}";\nexport const run = (n: number) => provider.alpha(n);\n`,
      ),
    ).toEqual(["alpha"]);
  });

  it("local rebinding", () => {
    expect(
      calleeNamesIn(
        `import { alpha } from "${PACKAGE}";\nconst call = alpha;\nexport const run = (n: number) => call(n);\n`,
      ),
    ).toEqual(["alpha"]);
  });

  it("receiver made by a factory", () => {
    const project = createTestProject();
    project.createSourceFile(
      `/node_modules/${PACKAGE}/package.json`,
      JSON.stringify({ name: PACKAGE, types: "index.d.ts" }),
    );
    project.createSourceFile(
      `/node_modules/${PACKAGE}/index.d.ts`,
      "export declare function createClient(): { getUser(id: string): unknown };\n",
    );
    const file = project.createSourceFile(
      "/consumer.ts",
      `import { createClient } from "${PACKAGE}";\nconst client = createClient();\nexport const run = (id: string) => client.getUser(id);\n`,
    );
    const store = new ResolutionStore();
    const calls: CallExpression[] = [];
    file.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        calls.push(node);
      }
    });
    const last = calls[calls.length - 1];
    const callee = last?.getExpression();
    if (callee === undefined || !Node.isPropertyAccessExpression(callee)) {
      throw new Error("fixture shape unexpected");
    }
    const receiver = callee.getExpression();
    expect(
      store.importOriginsOf(receiver, [PACKAGE]).map((one) => one.path),
    ).toEqual([["createClient"]]);
  });
});
