import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTsDiscoveryContext } from "./discoveryContext.js";
import { ResolutionStore } from "./facts/store.js";

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

describe("exportedCallConfigString", () => {
  const spec = {
    callees: ["makeWidgetHandler"],
    argIndex: 0,
    property: "subject",
  };

  it("reads the subject through an as-const cast", () => {
    const file = sourceFile(`
      declare function makeWidgetHandler(c: unknown, b: unknown): unknown;
      export const handler = makeWidgetHandler(
        { name: "w", subject: "billing.invoicePaid" as const },
        async () => undefined,
      );
    `);
    expect(ctx.exportedCallConfigString(file, "handler", spec)).toBe(
      "billing.invoicePaid",
    );
  });

  it("answers null for a computed subject", () => {
    const file = sourceFile(`
      declare function makeWidgetHandler(c: unknown, b: unknown): unknown;
      const source = "billing";
      export const handler = makeWidgetHandler(
        { subject: \`\${source}.refundIssued\` },
        async () => undefined,
      );
    `);
    expect(ctx.exportedCallConfigString(file, "handler", spec)).toBeNull();
  });

  it("answers null when the callee is not in the list", () => {
    const file = sourceFile(`
      declare function otherFactory(c: unknown, b: unknown): unknown;
      export const handler = otherFactory(
        { subject: "billing.invoicePaid" },
        async () => undefined,
      );
    `);
    expect(ctx.exportedCallConfigString(file, "handler", spec)).toBeNull();
  });

  it("answers null when the export is not a call", () => {
    const file = sourceFile("export const handler = async () => undefined;");
    expect(ctx.exportedCallConfigString(file, "handler", spec)).toBeNull();
  });

  it("follows a config variable to the object literal it names", () => {
    const rctx = createTsDiscoveryContext(new ResolutionStore());
    const file = sourceFile(`
      declare function makeWidgetHandler(c: unknown, b: unknown): unknown;
      const config = { subject: "user.deleted" as const };
      export const handler = makeWidgetHandler(config, async () => undefined);
    `);
    expect(rctx.exportedCallConfigString(file, "handler", spec)).toBe(
      "user.deleted",
    );
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
