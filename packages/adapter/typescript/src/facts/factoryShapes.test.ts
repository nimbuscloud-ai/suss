// The shapes a handler factory comes in, and what each one has to
// resolve to. Every case here is one function reaching another through
// arguments, and no rule mentions any of them: the rules describe one hop
// and the engine composes the rest. A case that stops working is a
// missing fact rather than a missing rule.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { ResolutionStore } from "./store.js";

/** The line the exported handler's body comes down to, or null. */
function resolvedLine(source: string): number | null {
  const project = createTestProject();
  const file = project.createSourceFile("/mod.ts", source);
  const init = file.getVariableDeclarationOrThrow("handler").getInitializer();
  if (init === undefined) {
    return null;
  }
  const resolved = new ResolutionStore().resolveCallable(init);
  return resolved === null ? null : resolved.getStartLineNumber();
}

describe("a handler built by a factory", () => {
  it("resolves when the returned function calls the argument", () => {
    expect(
      resolvedLine(`function make(body: (x: number) => void) {
  return (e: number) => { body(e); };
}
export const handler = make((x) => { console.log(x); });`),
    ).toBe(4);
  });

  it("resolves when the returned arrow is written without braces", () => {
    expect(
      resolvedLine(`function make(body: (x: number) => void) {
  return (e: number) => body(e);
}
export const handler = make((x) => { console.log(x); });`),
    ).toBe(4);
  });

  it("resolves when a closure inside the returned function calls it", () => {
    // The shape a production SQS factory uses: the handler runs inside
    // a tracing span, so the argument is called two closures down.
    expect(
      resolvedLine(`declare function span(o: object, f: () => void): void;
function make(body: (x: number) => void) {
  return (e: number) => {
    const run = () => span({}, () => { body(e); });
    run();
  };
}
export const handler = make((x) => { console.log(x); });`),
    ).toBe(8);
  });

  it("resolves through a factory that hands off to another factory", () => {
    expect(
      resolvedLine(`function makeBatch(
  config: object,
  parse: (r: number) => number,
  body: (x: number) => void,
) {
  return (e: number) => { body(parse(e)); };
}
function createEvent(config: object, body: (x: number) => void) {
  return makeBatch(config, (r) => r, body);
}
export const handler = createEvent({ name: "x" }, (x) => { console.log(x); });`),
    ).toBe(11);
  });

  it("resolves both hops at once", () => {
    // Neither hop is written down as a rule. The delegating factory and
    // the nested closure compose, which is the whole reason the rules
    // are rules.
    expect(
      resolvedLine(`declare function span(o: object, f: () => void): void;
function makeBatch(
  config: object,
  parse: (r: number) => number,
  body: (x: number) => void,
) {
  return (e: number) => {
    const run = () => span({}, () => { body(parse(e)); });
    run();
  };
}
function createEvent(config: object, body: (x: number) => void) {
  return makeBatch(config, (r) => r, body);
}
export const handler = createEvent({ name: "x" }, (x) => { console.log(x); });`),
    ).toBe(15);
  });
});
