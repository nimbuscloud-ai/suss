import { Node } from "ts-morph";
import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "../facts/store.js";
import {
  propertiesOf,
  propertyNamed,
  propertyNameOf,
  propertyOf,
} from "./resolveValue.js";

import type { ObjectLiteralExpression } from "ts-morph";

/** The object literal `const <name> = { ... }` declares in the source. */
function objectNamed(
  source: string,
  name: string,
): { object: ObjectLiteralExpression; store: ResolutionStore } {
  const file = createTestProject().createSourceFile("/values.ts", source);
  const initializer = file.getVariableDeclarationOrThrow(name).getInitializer();
  if (
    initializer === undefined ||
    !Node.isObjectLiteralExpression(initializer)
  ) {
    throw new Error(`${name} is not an object literal`);
  }
  return { object: initializer, store: new ResolutionStore() };
}

describe("the properties an object has once it is built", () => {
  const SOURCE = `
    const base = { label: "base", size: "sm", onPick() {} };
    const meta = { ...base, label: "own", tone: "warn", onPick: undefined };
  `;

  it("puts a spread's properties in its place and keeps a name written again at its first place", () => {
    const { object, store } = objectNamed(SOURCE, "meta");

    expect(
      propertiesOf(object, store).map((property) => property.getText()),
    ).toEqual([
      'label: "own"',
      'size: "sm"',
      "onPick: undefined",
      'tone: "warn"',
    ]);
  });

  it("reads the property written last under a name", () => {
    const { object, store } = objectNamed(SOURCE, "meta");

    expect(propertyOf(object, "label", store)?.getText()).toBe('"own"');
    expect(propertyOf(object, "size", store)?.getText()).toBe('"sm"');
    expect(propertyNamed(object, "onPick", store)?.getText()).toBe(
      "onPick: undefined",
    );
    expect(propertyOf(object, "missing", store)).toBeNull();
  });

  it("reads a spread written again after a property it overrides", () => {
    const { object, store } = objectNamed(
      `
        const base = { label: "base" };
        const twice = { ...base, label: "own", ...base };
      `,
      "twice",
    );

    expect(propertyOf(object, "label", store)?.getText()).toBe('"base"');
    expect(propertiesOf(object, store).map(propertyNameOf)).toEqual(["label"]);
  });
});
