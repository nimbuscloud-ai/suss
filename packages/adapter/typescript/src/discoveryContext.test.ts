import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTsDiscoveryContext } from "./discoveryContext.js";

function sourceFile(code: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { jsx: 4 /* ReactJSX */ },
  });
  return project.createSourceFile("Comp.tsx", code);
}

const ctx = createTsDiscoveryContext();

describe("createTsDiscoveryContext", () => {
  it("getFilePath returns the source file's path", () => {
    expect(ctx.getFilePath(sourceFile("export const x = 1;"))).toMatch(
      /Comp\.tsx$/,
    );
  });

  it("yields function declarations, arrow + function-expression vars, and default; skips non-functions", () => {
    const file = sourceFile(`
      export function Foo() { return null; }
      export const Bar = () => null;
      export const Baz = function () { return null; };
      export const NOT_A_FN = 42;
      export class Cls {}
      export default function Main() { return null; }
    `);
    const fns = ctx.exportedFunctions(file);
    const byName = Object.fromEntries(fns.map((f) => [f.name, f.isDefault]));
    expect(Object.keys(byName).sort()).toEqual([
      "Bar",
      "Baz",
      "Foo",
      "default",
    ]);
    expect(byName.default).toBe(true);
    expect(byName.Foo).toBe(false);
  });

  it("detects a concise-arrow JSX body", () => {
    const file = sourceFile("export const C = () => <div />;");
    const fn = ctx.exportedFunctions(file)[0].func;
    expect(ctx.hasJsxReturn(fn)).toBe(true);
  });

  it("detects a JSX return statement, unwrapping parentheses and fragments", () => {
    const file = sourceFile("export function C() { return (<><span /></>); }");
    const fn = ctx.exportedFunctions(file)[0].func;
    expect(ctx.hasJsxReturn(fn)).toBe(true);
  });

  it("returns false when a function returns no JSX", () => {
    const file = sourceFile("export function C() { return 42; }");
    const fn = ctx.exportedFunctions(file)[0].func;
    expect(ctx.hasJsxReturn(fn)).toBe(false);
  });

  it("ignores JSX returned only by a nested function", () => {
    const file = sourceFile(
      "export function C() { const inner = () => <div />; return inner; }",
    );
    const fn = ctx.exportedFunctions(file)[0].func;
    expect(ctx.hasJsxReturn(fn)).toBe(false);
  });
});
