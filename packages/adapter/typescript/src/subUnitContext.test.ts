// subUnitContext.test.ts: the primitives packs use to walk a JSX
// attribute back to the function its value refers to.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "./facts/store.js";
import { createTsSubUnitContext } from "./subUnitContext.js";

import type { FunctionRoot } from "./conditions.js";

function componentFunction(source: string): FunctionRoot {
  const project = createTestProject();
  const file = project.createSourceFile("/component.tsx", source);
  const fn = file.getFunctions()[0];
  if (fn === undefined) {
    throw new Error("No function declaration in fixture");
  }
  return fn;
}

describe("resolveAttributeValueFunction", () => {
  it("follows a handler written as TS overload signatures to its implementation", () => {
    // A signature declaration resolves to its implementation, not to
    // itself: the earlier declaration has no body to walk.
    const parent = componentFunction(`
      function Form(props: { onSubmit: () => void }) {
        function handleSubmit(event: unknown): void;
        function handleSubmit(event: unknown) {
          props.onSubmit();
        }
        return <form onSubmit={handleSubmit} />;
      }
    `);
    const ctx = createTsSubUnitContext();
    const [attr] = ctx.findJsxAttributes(parent);
    if (attr === undefined) {
      throw new Error("No JSX attribute found in fixture");
    }

    const resolved = ctx.resolveAttributeValueFunction(attr, parent);

    expect(resolved).not.toBeNull();
    expect(resolved?.localName).toBe("handleSubmit");
    expect(resolved?.func.getBody()).toBeDefined();
  });
});

describe("calls", () => {
  const SOURCE = `
    function Orders() {
      load();
      items.map((item) => save(item));
      function helper() { log(); }
      new Date();
      return later(() => notify(), { run() { sweep(); } }, undefined);
    }
  `;

  it("lists the calls the parent's body runs as ops, inline functions included, in source order", () => {
    const parent = componentFunction(SOURCE);
    const ctx = createTsSubUnitContext(new ResolutionStore());

    const calls =
      ctx.calls?.({ func: parent, name: "Orders", kind: "component" }) ?? [];

    expect(calls.map((call) => call.calleeText())).toEqual([
      "load",
      "items.map",
      "save",
      "Date",
      "later",
      "notify",
    ]);
  });

  it("says how the source wrote each argument", () => {
    const parent = componentFunction(SOURCE);
    const ctx = createTsSubUnitContext(new ResolutionStore());
    const later = ctx
      .calls?.({ func: parent, name: "Orders", kind: "component" })
      .find((call) => call.calleeText() === "later");
    const options = later?.valueAt(1);

    expect(later?.valueAt(0)?.form?.()).toBe("function");
    expect(options?.form?.()).toBe("object");
    expect(options?.ownProperty?.("run")?.form?.()).toBe("function");
    expect(later?.valueAt(2)?.form?.()).toBe("other");
    expect(
      ctx
        .calls?.({ func: parent, name: "Orders", kind: "component" })
        .find((call) => call.calleeText() === "save")
        ?.valueAt(0)
        ?.form?.(),
    ).toBe("name");
  });

  it("is left out without a store", () => {
    expect(createTsSubUnitContext().calls).toBeUndefined();
  });
});
