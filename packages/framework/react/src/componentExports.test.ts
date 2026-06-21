import { describe, expect, it } from "vitest";

import { reactComponentExports } from "./componentExports.js";

import type {
  FunctionRoot,
  TsDiscoveryContext,
} from "@suss/adapter-typescript";

// reactComponentExports treats the source file opaquely (it only hands it
// to ctx methods) and drives everything through the discovery context, so
// a mock ctx exercises every branch without parsing real TSX. Each
// exported function carries a `__jsx` flag the mock's hasJsxReturn reads.

type Exported = { name: string; func: FunctionRoot; isDefault: boolean };

function fn(jsx: boolean): FunctionRoot {
  return { __jsx: jsx } as unknown as FunctionRoot;
}

function mockCtx(filePath: string, exports: Exported[]): TsDiscoveryContext {
  return {
    getFilePath: () => filePath,
    exportedFunctions: () => exports,
    hasJsxReturn: (f: FunctionRoot) =>
      (f as unknown as { __jsx: boolean }).__jsx === true,
  } as unknown as TsDiscoveryContext;
}

const sf = {} as unknown as Parameters<typeof reactComponentExports>[0];

describe("reactComponentExports", () => {
  it("skips story files", () => {
    const ctx = mockCtx("src/Button.stories.tsx", [
      { name: "Primary", func: fn(true), isDefault: false },
    ]);
    expect(reactComponentExports(sf, ctx)).toEqual([]);
  });

  it("skips test and spec files", () => {
    const exports = [{ name: "Widget", func: fn(true), isDefault: false }];
    expect(
      reactComponentExports(sf, mockCtx("src/Widget.test.tsx", exports)),
    ).toEqual([]);
    expect(
      reactComponentExports(sf, mockCtx("src/Widget.spec.tsx", exports)),
    ).toEqual([]);
  });

  it("discovers PascalCase named exports that return JSX", () => {
    const widget = fn(true);
    const out = reactComponentExports(
      sf,
      mockCtx("src/widgets.tsx", [
        { name: "Widget", func: widget, isDefault: false },
      ]),
    );
    expect(out).toEqual([{ func: widget, kind: "component", name: "Widget" }]);
  });

  it("skips the default export, lowercase names, non-JSX, and empty names", () => {
    const out = reactComponentExports(
      sf,
      mockCtx("src/mixed.tsx", [
        // default export — handled by the data-driven namedExport(["default"])
        { name: "Page", func: fn(true), isDefault: true },
        // lowercase — a render helper, not a component
        { name: "renderRow", func: fn(true), isDefault: false },
        // PascalCase but no JSX — a utility / hook-like function
        { name: "BuildConfig", func: fn(false), isDefault: false },
        // empty name — defensive guard in startsWithUppercase
        { name: "", func: fn(true), isDefault: false },
        // the one real component
        { name: "Card", func: fn(true), isDefault: false },
      ]),
    );
    expect(out.map((u) => u.name)).toEqual(["Card"]);
  });
});
