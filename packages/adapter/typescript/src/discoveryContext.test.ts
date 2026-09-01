import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { createTsDiscoveryContext } from "./discoveryContext.js";
import { ResolutionStore } from "./facts/store.js";

function sourceFile(code: string) {
  const project = createTestProject();
  return project.createSourceFile("Comp.tsx", code);
}

// A store keeps per-file state, and each fixture here is its own
// project under one path, so every ask gets its own context.
function ctx() {
  return createTsDiscoveryContext();
}

describe("createTsDiscoveryContext", () => {
  it("getFilePath returns the source file's path", () => {
    expect(ctx().getFilePath(sourceFile("export const x = 1;"))).toMatch(
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
    const fns = ctx().exportedFunctions(file);
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
    const fn = ctx().exportedFunctions(file)[0].func;
    expect(ctx().hasJsxReturn(fn)).toBe(true);
  });

  it("detects a JSX return statement, unwrapping parentheses and fragments", () => {
    const file = sourceFile("export function C() { return (<><span /></>); }");
    const fn = ctx().exportedFunctions(file)[0].func;
    expect(ctx().hasJsxReturn(fn)).toBe(true);
  });

  it("returns false when a function returns no JSX", () => {
    const file = sourceFile("export function C() { return 42; }");
    const fn = ctx().exportedFunctions(file)[0].func;
    expect(ctx().hasJsxReturn(fn)).toBe(false);
  });

  it("ignores JSX returned only by a nested function", () => {
    const file = sourceFile(
      "export function C() { const inner = () => <div />; return inner; }",
    );
    const fn = ctx().exportedFunctions(file)[0].func;
    expect(ctx().hasJsxReturn(fn)).toBe(false);
  });
});

describe("an export whose binding is written again", () => {
  it("reports the write that survives rather than the initializer", () => {
    const file = sourceFile(`
      function PanelImpl() { return <div />; }
      let Panel = () => <span />;
      Panel = PanelImpl;
      export { Panel };
    `);
    const withRules = createTsDiscoveryContext(new ResolutionStore());

    const found = withRules
      .exportedFunctions(file)
      .find((entry) => entry.name === "Panel");
    expect(found?.func.getText()).toContain("<div />");
  });

  it("reports nothing when a branch decides which write runs", () => {
    const file = sourceFile(`
      declare const flag: boolean;
      function PanelImpl() { return <div />; }
      let Panel = () => <span />;
      if (flag) { Panel = PanelImpl; }
      export { Panel };
    `);
    const withRules = createTsDiscoveryContext(new ResolutionStore());

    expect(
      withRules.exportedFunctions(file).map((entry) => entry.name),
    ).not.toContain("Panel");
  });
});
