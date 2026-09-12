// subUnitContext.test.ts: the primitives packs use to walk a JSX
// attribute back to the function its value refers to.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

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
