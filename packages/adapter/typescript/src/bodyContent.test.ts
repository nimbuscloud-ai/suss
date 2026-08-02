// A summary with nothing in it means one of two things, and only the
// adapter can see which: a declaration with no body behind it, or a
// body with nothing in it.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { bodyContentOf } from "./assembly.js";

import type { BodyContent } from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

function ofVariable(source: string, name = "handler"): BodyContent {
  const project = createTestProject();
  const file = project.createSourceFile("/mod.ts", source);
  const func = file
    .getVariableDeclarationOrThrow(name)
    .getInitializerOrThrow() as unknown as FunctionRoot;
  return bodyContentOf(func);
}

function ofFunction(source: string, name = "handler"): BodyContent {
  const project = createTestProject();
  const file = project.createSourceFile("/mod.ts", source);
  const func = file.getFunctionOrThrow(name) as unknown as FunctionRoot;
  return bodyContentOf(func);
}

describe("bodyContentOf", () => {
  it("says a body with statements has work in it", () => {
    expect(ofVariable("export const handler = () => { doThing(); };")).toBe(
      "statements",
    );
  });

  it("says a concise arrow's expression is work", () => {
    expect(ofVariable("export const handler = () => doThing();")).toBe(
      "statements",
    );
  });

  it("says a body with nothing in it is empty", () => {
    expect(ofVariable("export const handler = () => {};")).toBe("empty");
  });

  it("says an overload signature has no body behind it", () => {
    // The signature and the implementation are separate declarations,
    // and whoever discovers the signature reads no body at all.
    const project = createTestProject();
    const file = project.createSourceFile(
      "/mod.ts",
      `export function handler(a: number): void;
       export function handler(a: number): void { doThing(a); }`,
    );
    const implementation = file.getFunctionOrThrow("handler");
    const signature = implementation.getOverloads()[0];
    expect(bodyContentOf(signature as unknown as FunctionRoot)).toBe("absent");
    expect(bodyContentOf(implementation as unknown as FunctionRoot)).toBe(
      "statements",
    );
  });

  it("says an ambient declaration has no body behind it", () => {
    expect(ofFunction("declare function handler(a: number): void;")).toBe(
      "absent",
    );
  });
});
