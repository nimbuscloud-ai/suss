// A pack's terminals describe the shapes it knows. A function that
// returns something none of them match used to produce a summary with
// no transitions and no gaps, which reads as a function that does
// nothing rather than one nobody read.

import { describe, expect, it } from "vitest";

import { createTestProject } from "@suss/test-project";

import { countUnmatchedReturns } from "./assembly.js";
import { findTerminals } from "./terminals/index.js";

import type { TerminalPattern } from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

const HTTP_TERMINALS: TerminalPattern[] = [
  {
    kind: "response",
    match: { type: "returnShape", requiredProperties: ["statusCode"] },
    extraction: {},
  },
];

function countIn(source: string, name: string): number {
  const project = createTestProject();
  const file = project.createSourceFile("/mod.ts", source);
  const decl = file.getVariableDeclarationOrThrow(name);
  const func = decl.getInitializerOrThrow() as unknown as FunctionRoot;
  return countUnmatchedReturns(func, findTerminals(func, HTTP_TERMINALS));
}

describe("a value reached through a wrapper", () => {
  const HELPER = `function respond(code: number) {
    return { statusCode: code, body: "" };
  }`;

  function readsFrom(source: string): { terminals: number; unread: number } {
    const project = createTestProject();
    const file = project.createSourceFile("/mod.ts", source);
    const func = file
      .getVariableDeclarationOrThrow("handler")
      .getInitializerOrThrow() as unknown as FunctionRoot;
    const terminals = findTerminals(func, HTTP_TERMINALS);
    return {
      terminals: terminals.length,
      unread: countUnmatchedReturns(func, terminals),
    };
  }

  it("reads a helper the handler awaited", () => {
    expect(
      readsFrom(`${HELPER}
       export const handler = async () => { return await respond(200); };`),
    ).toEqual({ terminals: 1, unread: 0 });
  });

  it("reads a helper the handler wrapped in parentheses", () => {
    expect(
      readsFrom(`${HELPER}
       export const handler = async () => { return (respond(200)); };`),
    ).toEqual({ terminals: 1, unread: 0 });
  });

  it("leaves a getter's return to the getter", () => {
    // The getter is its own scope, so its 500 is not a second outcome
    // of the handler around it.
    expect(
      readsFrom(`export const handler = async () => {
         return {
           statusCode: 200,
           get inner() { return { statusCode: 500 }; },
         };
       };`),
    ).toEqual({ terminals: 1, unread: 0 });
  });
});

describe("countUnmatchedReturns", () => {
  it("counts a return the terminals do not describe", () => {
    expect(
      countIn(
        `export const handler = async () => {
           return { batchItemFailures: [] };
         };`,
        "handler",
      ),
    ).toBe(1);
  });

  it("counts nothing when a terminal claims the return", () => {
    expect(
      countIn(
        `export const handler = async () => {
           return { statusCode: 200, body: "" };
         };`,
        "handler",
      ),
    ).toBe(0);
  });

  it("counts each unmatched return separately", () => {
    expect(
      countIn(
        `export const handler = async (flag: boolean) => {
           if (flag) {
             return { batchItemFailures: [] };
           }
           return { ok: true };
         };`,
        "handler",
      ),
    ).toBe(2);
  });

  it("sees a ternary return as one return, claimed once", () => {
    expect(
      countIn(
        `export const handler = async (flag: boolean) => {
           return flag
             ? { statusCode: 200, body: "" }
             : { statusCode: 404, body: "" };
         };`,
        "handler",
      ),
    ).toBe(0);
  });

  it("sees through the parentheses a concise arrow needs", () => {
    expect(
      countIn(
        `export const handler = async () => ({ statusCode: 200, body: "" });`,
        "handler",
      ),
    ).toBe(0);
  });

  it("sees through parentheses around a returned value", () => {
    expect(
      countIn(
        `export const handler = async () => {
           return ({ statusCode: 200, body: "" });
         };`,
        "handler",
      ),
    ).toBe(0);
  });

  it("does not blame a return inside a getter on the function around it", () => {
    expect(
      countIn(
        `export const handler = async () => {
           return {
             statusCode: 200,
             get body() {
               return { somethingElse: true };
             },
           };
         };`,
        "handler",
      ),
    ).toBe(0);
  });

  it("leaves a bare return alone, since falling off the end covers it", () => {
    expect(
      countIn(
        `export const handler = async (flag: boolean) => {
           if (flag) {
             return;
           }
         };`,
        "handler",
      ),
    ).toBe(0);
  });

  it("does not count returns belonging to a nested function", () => {
    expect(
      countIn(
        `export const handler = async () => {
           const inner = () => {
             return { somethingElse: true };
           };
           return { statusCode: 200, body: inner() };
         };`,
        "handler",
      ),
    ).toBe(0);
  });
});

describe("countUnmatchedReturns across terminal shapes", () => {
  it("sees through an await around a returned call", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/mod.ts",
      `declare function json(body: unknown): { statusCode: number };
       export const handler = async () => {
         return await json({ a: 1 });
       };`,
    );
    const func = file
      .getVariableDeclarationOrThrow("handler")
      .getInitializerOrThrow() as unknown as FunctionRoot;

    const terminals: TerminalPattern[] = [
      {
        kind: "response",
        match: { type: "functionCall", functionName: "json" },
        extraction: {},
      },
    ];

    expect(countUnmatchedReturns(func, findTerminals(func, terminals))).toBe(0);
  });

  it("says nothing is unread when the whole function is the terminal", () => {
    const project = createTestProject();
    const file = project.createSourceFile(
      "/mod.tsx",
      "export const Card = () => <div />;",
    );
    const func = file
      .getVariableDeclarationOrThrow("Card")
      .getInitializerOrThrow() as unknown as FunctionRoot;

    const terminals: TerminalPattern[] = [
      { kind: "render", match: { type: "jsxReturn" }, extraction: {} },
    ];

    // A component that returns JSX with no return statement: the
    // terminal is anchored on the function itself.
    expect(countUnmatchedReturns(func, findTerminals(func, terminals))).toBe(0);
  });
});
