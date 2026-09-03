import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { surfaceMethods } from "./factorySurface.js";

import type { FunctionRoot } from "../conditions.js";

function surfacedNames(source: string, declName: string): string[] {
  const project = createTestProject();
  const file = project.createSourceFile("/probe.ts", source);
  const decl = file.getFunctionOrThrow(declName);
  return surfaceMethods(decl as unknown as FunctionRoot)
    .map((m) => m.name)
    .sort();
}

function surfacedNamesFromClass(source: string, declName: string): string[] {
  const project = createTestProject();
  const file = project.createSourceFile("/probe.ts", source);
  const decl = file.getClassOrThrow(declName);
  return surfaceMethods(decl)
    .map((m) => m.name)
    .sort();
}

describe("surfaceMethods: object-literal returns", () => {
  it("surfaces a method-shorthand property and an arrow property", () => {
    const names = surfacedNames(
      `
      function createX() {
        return { method() {}, prop: () => {} };
      }
    `,
      "createX",
    );
    expect(names).toEqual(["method", "prop"]);
  });

  it("skips a spread property and a non-callable value", () => {
    const names = surfacedNames(
      `
      function createX(other: { extra(): void }) {
        return { ...other, count: 1, method() {} };
      }
    `,
      "createX",
    );
    expect(names).toEqual(["method"]);
  });

  it("surfaces every public instance and static method on a class", () => {
    const names = surfacedNamesFromClass(
      `
      class ApiClient {
        constructor() {}
        get() {}
        private helper() {}
        static create() {}
      }
    `,
      "ApiClient",
    );
    expect(names).toEqual(["create", "get"]);
  });
});

describe("surfaceMethods: shorthand over inner functions", () => {
  it("surfaces a shorthand property bound to a function declared in the factory body", () => {
    const names = surfacedNames(
      `
      function createAdapterStamp(config: { moduleUrl: string }) {
        function codeStamp() {
          return config.moduleUrl;
        }
        function packsDigest() {
          return codeStamp();
        }
        return { codeStamp, packsDigest };
      }
    `,
      "createAdapterStamp",
    );
    expect(names).toEqual(["codeStamp", "packsDigest"]);
  });

  it("surfaces a shorthand property bound to a module-scope arrow function", () => {
    const names = surfacedNames(
      `
      const helper = () => 1;
      function createX() {
        return { helper };
      }
    `,
      "createX",
    );
    expect(names).toEqual(["helper"]);
  });

  it("leaves a shorthand property bound to a non-function local unsurfaced", () => {
    const names = surfacedNames(
      `
      function createX() {
        const count = 1;
        return { count };
      }
    `,
      "createX",
    );
    expect(names).toEqual([]);
  });

  it("leaves a shorthand property bound to an import from another file unsurfaced", () => {
    const project = createTestProject();
    project.createSourceFile(
      "/other.ts",
      "export function helper() { return 1; }",
    );
    const file = project.createSourceFile(
      "/probe.ts",
      `
      import { helper } from "./other";
      export function createX() {
        return { helper };
      }
    `,
    );
    const decl = file.getFunctionOrThrow("createX");
    expect(surfaceMethods(decl as unknown as FunctionRoot)).toEqual([]);
  });
});

describe("surfaceMethods: return through a same-file helper", () => {
  it("surfaces the methods a same-file helper's own return builds", () => {
    const names = surfacedNames(
      `
      export function messageSends(spec: unknown) {
        return chainFrom(spec);
      }
      function chainFrom(declared: unknown) {
        return {
          methods: (table: unknown) => chainFrom(declared),
          example: (code: unknown) => chainFrom(declared),
        };
      }
    `,
      "messageSends",
    );
    expect(names).toEqual(["example", "methods"]);
  });

  it("chases two hops through same-file helpers", () => {
    const names = surfacedNames(
      `
      function createX(spec: unknown) {
        return first(spec);
      }
      function first(spec: unknown) {
        return second(spec);
      }
      function second(spec: unknown) {
        return { method() {} };
      }
    `,
      "createX",
    );
    expect(names).toEqual(["method"]);
  });

  it("stops chasing a helper chain past the depth bound", () => {
    const names = surfacedNames(
      `
      function createX(spec: unknown) {
        return first(spec);
      }
      function first(spec: unknown) {
        return second(spec);
      }
      function second(spec: unknown) {
        return third(spec);
      }
      function third(spec: unknown) {
        return { method() {} };
      }
    `,
      "createX",
    );
    expect(names).toEqual([]);
  });
});
